import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export const MAX_ORCHESTRATION_MESSAGE_WAITERS = 1_024
export const MAX_ORCHESTRATION_MESSAGE_WAITERS_PER_HANDLE = 64
export const MAX_ORCHESTRATION_MESSAGE_WAITER_HANDLE_BYTES = 64 * 1024
export const MAX_ORCHESTRATION_MESSAGE_WAITER_RETAINED_HANDLE_BYTES = 1024 * 1024

const DEFAULT_MESSAGE_WAIT_TIMEOUT_MS = 2 * 60 * 1000

export type OrchestrationMessageWaiterBounds = {
  maxWaiters: number
  maxWaitersPerHandle: number
  maxHandleBytes: number
  maxRetainedHandleBytes: number
}

type MessageWaiterBucket = {
  handle: string
  handleBytes: number
  waiters: Set<MessageWaiter>
}

type MessageWaiter = {
  bucket: MessageWaiterBucket
  typeFilter: Set<string> | undefined
  resolve: () => void
  timeout: ReturnType<typeof setTimeout> | null
  signal: AbortSignal | undefined
  onAbort: () => void
  active: boolean
}

const DEFAULT_BOUNDS: OrchestrationMessageWaiterBounds = {
  maxWaiters: MAX_ORCHESTRATION_MESSAGE_WAITERS,
  maxWaitersPerHandle: MAX_ORCHESTRATION_MESSAGE_WAITERS_PER_HANDLE,
  maxHandleBytes: MAX_ORCHESTRATION_MESSAGE_WAITER_HANDLE_BYTES,
  maxRetainedHandleBytes: MAX_ORCHESTRATION_MESSAGE_WAITER_RETAINED_HANDLE_BYTES
}

export type OrchestrationMessageWaiterLimitReason =
  | 'global'
  | 'per-handle'
  | 'handle-bytes'
  | 'retained-handle-bytes'

export class OrchestrationMessageWaiterLimitError extends Error {
  constructor(
    readonly reason: OrchestrationMessageWaiterLimitReason,
    readonly limit: number
  ) {
    super(getLimitErrorMessage(reason, limit))
    this.name = 'OrchestrationMessageWaiterLimitError'
  }
}

export class OrchestrationMessageWaiterRegistry {
  private readonly waitersByHandle = new Map<string, MessageWaiterBucket>()
  private waiterCount = 0
  private retainedHandleBytes = 0
  private closed = false

  constructor(
    private readonly bounds: OrchestrationMessageWaiterBounds = DEFAULT_BOUNDS,
    private readonly defaultTimeoutMs = DEFAULT_MESSAGE_WAIT_TIMEOUT_MS
  ) {
    if (
      !Number.isSafeInteger(bounds.maxWaiters) ||
      bounds.maxWaiters < 1 ||
      !Number.isSafeInteger(bounds.maxWaitersPerHandle) ||
      bounds.maxWaitersPerHandle < 1 ||
      !Number.isSafeInteger(bounds.maxHandleBytes) ||
      bounds.maxHandleBytes < 1 ||
      !Number.isSafeInteger(bounds.maxRetainedHandleBytes) ||
      bounds.maxRetainedHandleBytes < 1
    ) {
      throw new RangeError('Orchestration message waiter bounds must be positive integers')
    }
  }

  wait(
    handle: string,
    options: { typeFilter?: string[]; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<void> {
    if (options.signal?.aborted || this.closed) {
      return Promise.resolve()
    }

    const bucket = this.admit(handle)
    const typeFilter = options.typeFilter ? new Set(options.typeFilter) : undefined

    return new Promise((resolve) => {
      let waiter!: MessageWaiter
      const onAbort = (): void => this.settle(waiter)
      waiter = {
        bucket,
        typeFilter,
        resolve,
        timeout: null,
        signal: options.signal,
        onAbort,
        active: true
      }
      this.retain(waiter)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) {
        this.settle(waiter)
        return
      }
      waiter.timeout = setTimeout(
        () => this.settle(waiter),
        options.timeoutMs ?? this.defaultTimeoutMs
      )
    })
  }

  notify(handle: string, messageType?: string): number {
    const bucket = this.waitersByHandle.get(handle)
    if (!bucket) {
      return 0
    }

    let notified = 0
    for (const waiter of Array.from(bucket.waiters)) {
      if (messageType && waiter.typeFilter && !waiter.typeFilter.has(messageType)) {
        continue
      }
      this.settle(waiter)
      notified += 1
    }
    return notified
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const bucket of this.waitersByHandle.values()) {
      for (const waiter of bucket.waiters) {
        this.settle(waiter)
      }
    }
  }

  evidence(): { waiters: number; handles: number; retainedHandleBytes: number } {
    return {
      waiters: this.waiterCount,
      handles: this.waitersByHandle.size,
      retainedHandleBytes: this.retainedHandleBytes
    }
  }

  private admit(handle: string): MessageWaiterBucket {
    const existing = this.waitersByHandle.get(handle)
    if (existing) {
      if (this.waiterCount >= this.bounds.maxWaiters) {
        throw new OrchestrationMessageWaiterLimitError('global', this.bounds.maxWaiters)
      }
      if (existing.waiters.size >= this.bounds.maxWaitersPerHandle) {
        throw new OrchestrationMessageWaiterLimitError(
          'per-handle',
          this.bounds.maxWaitersPerHandle
        )
      }
      return existing
    }

    const measurement = measureUtf8ByteLength(handle, {
      stopAfterBytes: this.bounds.maxHandleBytes
    })
    if (measurement.exceededLimit) {
      throw new OrchestrationMessageWaiterLimitError('handle-bytes', this.bounds.maxHandleBytes)
    }
    if (this.waiterCount >= this.bounds.maxWaiters) {
      throw new OrchestrationMessageWaiterLimitError('global', this.bounds.maxWaiters)
    }
    if (measurement.byteLength > this.bounds.maxRetainedHandleBytes - this.retainedHandleBytes) {
      throw new OrchestrationMessageWaiterLimitError(
        'retained-handle-bytes',
        this.bounds.maxRetainedHandleBytes
      )
    }
    return {
      handle,
      handleBytes: measurement.byteLength,
      waiters: new Set()
    }
  }

  private retain(waiter: MessageWaiter): void {
    const { bucket } = waiter
    if (bucket.waiters.size === 0) {
      this.waitersByHandle.set(bucket.handle, bucket)
      this.retainedHandleBytes += bucket.handleBytes
    }
    bucket.waiters.add(waiter)
    this.waiterCount += 1
  }

  private settle(waiter: MessageWaiter): void {
    if (!waiter.active) {
      return
    }
    waiter.active = false
    if (waiter.timeout !== null) {
      clearTimeout(waiter.timeout)
      waiter.timeout = null
    }
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    const { bucket } = waiter
    if (bucket.waiters.delete(waiter)) {
      this.waiterCount -= 1
    }
    if (bucket.waiters.size === 0 && this.waitersByHandle.delete(bucket.handle)) {
      this.retainedHandleBytes -= bucket.handleBytes
    }
    waiter.resolve()
  }
}

function getLimitErrorMessage(
  reason: OrchestrationMessageWaiterLimitReason,
  limit: number
): string {
  if (reason === 'handle-bytes') {
    return `Orchestration message wait handle exceeds ${limit} UTF-8 bytes.`
  }
  if (reason === 'per-handle') {
    return `Orchestration message wait capacity reached for this terminal (${limit}); retry shortly.`
  }
  if (reason === 'retained-handle-bytes') {
    return `Orchestration message wait handle capacity reached (${limit} UTF-8 bytes); retry shortly.`
  }
  return `Orchestration message wait capacity reached (${limit}); retry shortly.`
}
