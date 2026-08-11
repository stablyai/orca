import type { ChildProcess } from 'node:child_process'
import type {
  AiVaultServiceInit,
  AiVaultServiceLane,
  AiVaultServiceRequest
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
  init: Omit<AiVaultServiceInit, 'type' | 'protocol'>
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

export function armAiVaultServiceCancellationTimeout(
  call: AiVaultServicePendingCall,
  onExpired: () => void
): void {
  if (call.timer) {
    clearTimeout(call.timer)
  }
  call.timer = setTimeout(onExpired, AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS)
  call.timer.unref?.()
}

/**
 * A cold start that faults before the request reached the child self-heals on
 * the scheduled respawn. Requeue once; the caller rejects when this returns false.
 */
export function requeueAiVaultServiceStart(
  call: AiVaultServicePendingCall,
  queue: AiVaultServicePendingCall[]
): boolean {
  if (call.sent || call.cancelled || call.startRetried) {
    return false
  }
  call.startRetried = true
  queue.unshift(call)
  return true
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
