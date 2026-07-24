import { INCREMENTAL_DRAIN_RETAINED_BYTE_LIMIT } from './transcript-incremental-reader'
import { MAX_NATIVE_CHAT_TRANSCRIPT_PAGE_RETAINED_BYTES } from './transcript-tail-reader'

export const MAX_NATIVE_CHAT_TRANSCRIPT_READ_CONCURRENCY = 8
export const MAX_NATIVE_CHAT_TRANSCRIPT_READ_WAITERS = 256
export const MAX_NATIVE_CHAT_TRANSCRIPT_PROCESS_RETAINED_BYTES = 128 * 1024 * 1024
export const NATIVE_CHAT_TRANSCRIPT_PAGE_RESERVATION_BYTES =
  MAX_NATIVE_CHAT_TRANSCRIPT_PAGE_RETAINED_BYTES
export const NATIVE_CHAT_TRANSCRIPT_WATCH_DRAIN_RESERVATION_BYTES =
  MAX_NATIVE_CHAT_TRANSCRIPT_PAGE_RETAINED_BYTES + INCREMENTAL_DRAIN_RETAINED_BYTE_LIMIT

type AdmissionWaiter = {
  abort: (() => void) | null
  bytes: number
  reject: (error: Error) => void
  resolve: (release: () => void) => void
  signal?: AbortSignal
}

function abortedReadError(): Error {
  const error = new Error('Native chat transcript read was canceled')
  error.name = 'AbortError'
  return error
}

export class NativeChatTranscriptReadAdmission {
  private activeBytes = 0
  private activeReads = 0
  private readonly waiters: AdmissionWaiter[] = []

  constructor(
    private readonly maxBytes = MAX_NATIVE_CHAT_TRANSCRIPT_PROCESS_RETAINED_BYTES,
    private readonly maxActive = MAX_NATIVE_CHAT_TRANSCRIPT_READ_CONCURRENCY,
    private readonly maxWaiters = MAX_NATIVE_CHAT_TRANSCRIPT_READ_WAITERS
  ) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      !Number.isSafeInteger(maxActive) ||
      maxActive < 1 ||
      !Number.isSafeInteger(maxWaiters) ||
      maxWaiters < 0
    ) {
      throw new RangeError('Invalid native chat transcript read admission limits')
    }
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maxBytes) {
      throw new RangeError('Native chat transcript read exceeds the process memory budget')
    }
    if (signal?.aborted) {
      return Promise.reject(abortedReadError())
    }
    const canAdmitImmediately =
      this.waiters.length === 0 &&
      this.activeReads < this.maxActive &&
      bytes <= this.maxBytes - this.activeBytes
    if (!canAdmitImmediately && this.waiters.length >= this.maxWaiters) {
      throw new Error('Too many queued native chat transcript reads')
    }

    return new Promise((resolve, reject) => {
      const waiter: AdmissionWaiter = {
        abort: null,
        bytes,
        reject,
        resolve,
        ...(signal ? { signal } : {})
      }
      if (signal) {
        waiter.abort = (): void => {
          const index = this.waiters.indexOf(waiter)
          if (index < 0) {
            return
          }
          this.waiters.splice(index, 1)
          signal.removeEventListener('abort', waiter.abort!)
          waiter.abort = null
          reject(abortedReadError())
          this.admitWaiters()
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      this.waiters.push(waiter)
      this.admitWaiters()
    })
  }

  get activeCount(): number {
    return this.activeReads
  }

  get queuedCount(): number {
    return this.waiters.length
  }

  get retainedBytes(): number {
    return this.activeBytes
  }

  private admitWaiters(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0]
      if (this.activeReads >= this.maxActive || waiter.bytes > this.maxBytes - this.activeBytes) {
        return
      }
      this.waiters.shift()
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort)
        waiter.abort = null
      }
      this.activeReads += 1
      this.activeBytes += waiter.bytes
      let released = false
      waiter.resolve(() => {
        if (released) {
          return
        }
        released = true
        this.activeReads -= 1
        this.activeBytes -= waiter.bytes
        this.admitWaiters()
      })
    }
  }
}

export const nativeChatTranscriptReadAdmission = new NativeChatTranscriptReadAdmission()

export async function withNativeChatTranscriptWatchDrainAdmission<T>(
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  const release = await nativeChatTranscriptReadAdmission.acquire(
    NATIVE_CHAT_TRANSCRIPT_WATCH_DRAIN_RESERVATION_BYTES,
    signal
  )
  try {
    return await run()
  } finally {
    release()
  }
}
