import type { SessionSearchScanRoots } from '../ai-vault-search/session-search-scan-roots'
import type { ChildProcess } from 'node:child_process'
import { createAiVaultScanCancelledError } from './ai-vault-scan-cancellation'
import type { AiVaultServiceScanListener } from './session-scanner-service-request-deadline'
import {
  AI_VAULT_SERVICE_PROTOCOL_VERSION,
  aiVaultServiceLane,
  type AiVaultServiceInit,
  type AiVaultServiceLane,
  type AiVaultServiceRequest,
  type AiVaultSessionSearchInit
} from './session-scanner-service-protocol'

export const AI_VAULT_SERVICE_READY_TIMEOUT_MS = 5_000
export const AI_VAULT_SERVICE_MAX_CALLS = 16
export const AI_VAULT_SERVICE_IDLE_TIMEOUT_MS = 10 * 60_000
export const AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS = 2_000

export type AiVaultServiceProcessFactory = () => ChildProcess
export type AiVaultServiceClientOptions = {
  processFactory: AiVaultServiceProcessFactory
  /** Resolve current consent on every spawn. */
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

  /** IPC ordering protects later requests; only idle children fault on missing acknowledgement. */
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

/** Retire on request deadlines to allow cache persistence; kill broken channels immediately. */
export function stopAiVaultServiceChild(child: ChildProcess, retire: boolean): void {
  if (retire) {
    retireAiVaultServiceChild(child)
    return
  }
  child.removeAllListeners()
  child.kill()
}

export function createAiVaultServicePendingCall(
  request: AiVaultServiceRequest,
  signal: AbortSignal | undefined,
  resolve: (value: unknown) => void,
  reject: (error: Error) => void,
  cancel: (call: AiVaultServicePendingCall) => void,
  scanListener?: AiVaultServiceScanListener
): AiVaultServicePendingCall {
  const call: AiVaultServicePendingCall = {
    request,
    scanListener,
    lane: aiVaultServiceLane(request.operation),
    signal,
    resolve,
    reject,
    timer: null,
    onAbort: null,
    cancelled: false,
    sent: false,
    startRetried: false
  }
  if (signal) {
    call.onAbort = () => cancel(call)
    signal.addEventListener('abort', call.onAbort, { once: true })
  }
  return call
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
  // Unsent calls get no acknowledgement; waiting would stall the lane and fault a healthy child.
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

/** Retry an unsent cold-start request once when a respawn is scheduled. */
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
  sent: boolean
  startRetried: boolean
  scanListener?: AiVaultServiceScanListener
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

/** Index reconciliation is invisible to the parent, so enabled indexing prevents idle retirement. */
export class AiVaultServiceSessionSearchHold {
  private enabled = false

  get holdsChild(): boolean {
    return this.enabled
  }

  record(init: AiVaultSessionSearchInit, child: ChildProcess | null): boolean {
    this.enabled = init.settings.enabled
    child?.send({ type: 'sessionSearch', init })
    return this.enabled
  }
}
