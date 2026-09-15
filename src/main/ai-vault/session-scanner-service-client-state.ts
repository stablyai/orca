import type { SessionSearchScanRoots } from '../ai-vault-search/session-search-scan-roots'
import type { ChildProcess } from 'node:child_process'
import { createAiVaultScanCancelledError } from './ai-vault-scan-cancellation'
import {
  AI_VAULT_SERVICE_PROTOCOL_VERSION,
  type AiVaultServiceInit,
  type AiVaultServiceLane,
  type AiVaultServiceRequest,
  type AiVaultSessionSearchInit
} from './session-scanner-service-protocol'

export const AI_VAULT_SERVICE_READY_TIMEOUT_MS = 5_000

export const AI_VAULT_SERVICE_SCAN_TIMEOUT_MS = 130_000

export const AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS = 15_000

export const AI_VAULT_SERVICE_MAX_CALLS = 16

export const AI_VAULT_SERVICE_IDLE_TIMEOUT_MS = 10 * 60_000

export const AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS = 2_000

export type AiVaultServiceProcessFactory = () => ChildProcess

export type AiVaultServiceClientOptions = {
  processFactory: AiVaultServiceProcessFactory
  /** Resolved per spawn: a respawned child must see current consent, not the first frame's. */
  init: () => Omit<AiVaultServiceInit, 'type' | 'protocol'>
  resolveSessionSearchRoots?: () => Promise<SessionSearchScanRoots>
  idleTimeoutMs?: number
  onStderr?: (text: string) => void
}

export type AiVaultServiceInvalidation = {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class AiVaultServiceInvalidations {
  private readonly pending = new Map<number, AiVaultServiceInvalidation>()
  private generation = 0

  get size(): number {
    return this.pending.size
  }

  open(
    timeoutMs: number,
    onTimeout: (generation: number) => void,
    send: (generation: number) => void
  ): Promise<void> {
    const generation = ++this.generation

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => onTimeout(generation), timeoutMs)
      timer.unref?.()
      this.pending.set(generation, { resolve, reject, timer })
      send(generation)
    })
  }

  /**
   * Sends one invalidation and resolves on the child's acknowledgement.
   *
   * The deadline is a startup-sized budget, but a child mid-scan can be slow to
   * turn the channel around. Fork IPC ordering already guarantees the child
   * applies the invalidation before any request sent after it, so a busy child
   * owes nothing here -- only an idle one that misses the deadline is wedged.
   */
  send(
    child: ChildProcess,
    paths: string[],
    lanes: { busy: () => boolean; onFault: (error: Error) => void }
  ): Promise<void> {
    return this.open(
      AI_VAULT_SERVICE_READY_TIMEOUT_MS,
      (generation) =>
        lanes.busy()
          ? void this.settle(generation)
          : lanes.onFault(new Error('AI Vault service cache invalidation timed out.')),
      (generation) => child.send({ type: 'invalidate', generation, paths })
    )
  }

  settle(generation: number): boolean {
    const entry = this.pending.get(generation)

    if (!entry) {
      return false
    }

    clearTimeout(entry.timer)
    this.pending.delete(generation)
    entry.resolve()

    return true
  }

  rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }

    this.pending.clear()
  }
}

export function createAiVaultServiceReadyWaiter(
  timeoutMs: number,
  onTimeout: () => void
): AiVaultServiceReadyWaiter {
  let resolve!: (child: ChildProcess) => void
  let reject!: (error: Error) => void

  const promise = new Promise<ChildProcess>((resolveReady, rejectReady) => {
    resolve = resolveReady
    reject = rejectReady
  })

  const timer = setTimeout(onTimeout, timeoutMs)
  timer.unref?.()

  return { promise, resolve, reject, timer }
}

export function retireAiVaultServiceChild(child: ChildProcess): void {
  child.removeAllListeners('message')
  child.removeAllListeners('disconnect')
  child.removeAllListeners('error')
  child.removeAllListeners('exit')
  const killTimer = setTimeout(() => child.kill(), AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS)
  killTimer.unref?.()
  child.once('exit', () => clearTimeout(killTimer))
  child.send({ type: 'shutdown' }, () => undefined)
  child.unref()
}

function armAiVaultServiceCancellationTimeout(
  call: AiVaultServicePendingCall,
  onExpired: () => void
): void {
  if (call.timer) {
    clearTimeout(call.timer)
  }

  call.timer = setTimeout(onExpired, AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS)
  call.timer.unref?.()
}

/** Abandons one call, and waits for the child's acknowledgement only when it owes one. */
export function cancelAiVaultServiceCall(
  call: AiVaultServicePendingCall,
  lanes: {
    queue: AiVaultServicePendingCall[]
    active: Map<AiVaultServiceLane, AiVaultServicePendingCall>
    child: ChildProcess | null
    pump: () => void
    onFault: (error: Error) => void
  }
): void {
  if (call.cancelled) {
    return
  }

  call.cancelled = true
  call.reject(createAiVaultScanCancelledError())
  const queuedIndex = lanes.queue.indexOf(call)

  if (queuedIndex !== -1) {
    lanes.queue.splice(queuedIndex, 1)
    clearAiVaultServiceCall(call)
    lanes.pump()

    return
  }

  if (lanes.active.get(call.lane) !== call) {
    return
  }

  // Why: a call cancelled before it reached the child gets no acknowledgement,
  // so waiting on one would kill a healthy service and stall the lane.
  if (!call.sent) {
    lanes.active.delete(call.lane)
    clearAiVaultServiceCall(call)
    lanes.pump()

    return
  }

  lanes.child?.send({ type: 'cancel', id: call.request.id })
  armAiVaultServiceCancellationTimeout(call, () =>
    lanes.onFault(new Error('AI Vault service did not cancel within 2000ms.'))
  )
}

/** Wires a freshly forked child to the client's callbacks and hands it the init frame. */
export function attachAiVaultServiceChild(
  child: ChildProcess,
  init: ReturnType<AiVaultServiceClientOptions['init']>,
  handlers: {
    onMessage: (message: unknown) => void
    onFault: (error: Error) => void
    onStderr?: (text: string) => void
  }
): void {
  child.on('message', handlers.onMessage)
  child.on('error', handlers.onFault)
  child.on('disconnect', () => handlers.onFault(new Error('AI Vault service disconnected.')))
  child.on('exit', (code) => handlers.onFault(new Error(`AI Vault service exited (${code}).`)))
  child.stderr?.on('data', (chunk: Buffer) => handlers.onStderr?.(String(chunk)))
  child.send({
    type: 'init',
    protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION,
    ...init
  } satisfies AiVaultServiceInit)
}

/**
 * A cold start that faults before the request reached the child self-heals on
 * the scheduled respawn. Requeue once; anything else is the caller's error.
 */
export function requeueOrRejectAiVaultServiceStart(
  call: AiVaultServicePendingCall,
  queue: AiVaultServicePendingCall[],
  error: Error,
  respawning: boolean
): void {
  if (!respawning || call.sent || call.cancelled || call.startRetried) {
    rejectAiVaultServiceCall(call, error)

    return
  }

  call.startRetried = true
  queue.unshift(call)
}

export function aiVaultServiceErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function clearAiVaultServiceCall(call: AiVaultServicePendingCall): void {
  if (call.timer) {
    clearTimeout(call.timer)
    call.timer = null
  }

  if (call.signal && call.onAbort) {
    call.signal.removeEventListener('abort', call.onAbort)
    call.onAbort = null
  }
}

export function rejectAiVaultServiceCall(call: AiVaultServicePendingCall, error: Error): void {
  clearAiVaultServiceCall(call)

  if (!call.cancelled) {
    call.reject(error)
  }
}

export type AiVaultServicePendingCall = {
  request: AiVaultServiceRequest
  lane: AiVaultServiceLane
  signal?: AbortSignal
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  onAbort: (() => void) | null
  cancelled: boolean
  /** Whether the child received the request; an unsent call gets no reply. */
  sent: boolean
  startRetried: boolean
}

export type AiVaultServiceReadyWaiter = {
  promise: Promise<ChildProcess>
  resolve: (child: ChildProcess) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class AiVaultServiceIdleRetirement {
  private timer: NodeJS.Timeout | null = null

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  schedule(busy: boolean, timeoutMs: number, retire: () => void): void {
    if (busy || this.timer) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      retire()
    }, timeoutMs)
    this.timer.unref?.()
  }
}

/**
 * The parent's half of the index setting.
 *
 * A child running the index is never idle from out here -- its reconcile loop is
 * invisible to the parent -- so this is what stops idle retirement ending the
 * indexing until some later scan happens to respawn a child.
 */
export class AiVaultServiceSessionSearchHold {
  private enabled = false

  /** True while a running index needs a child to exist. */
  get holdsChild(): boolean {
    return this.enabled
  }

  /**
   * Records the policy and tells a live child. A missing one reads the same
   * policy out of its init frame, which is why `init` is a factory, not a value.
   * @returns whether a child now has to exist.
   */
  record(init: AiVaultSessionSearchInit, child: ChildProcess | null): boolean {
    this.enabled = init.settings.enabled
    child?.send({ type: 'sessionSearch', init })

    return this.enabled
  }
}

/** Starts the request deadline only once the child is ready to receive it. */
export function sendAiVaultServiceCall(
  child: ChildProcess,
  call: AiVaultServicePendingCall,
  isActive: () => boolean,
  onFault: (error: Error) => void
): void {
  if (call.cancelled || !isActive()) {
    return
  }

  const timeoutMs =
    call.request.operation === 'scan'
      ? AI_VAULT_SERVICE_SCAN_TIMEOUT_MS
      : AI_VAULT_SERVICE_INTERACTIVE_TIMEOUT_MS

  call.timer = setTimeout(() => {
    onFault(new Error(`AI Vault service timed out after ${timeoutMs}ms.`))
  }, timeoutMs)
  call.timer.unref?.()
  call.sent = true
  child.send(call.request)
}
