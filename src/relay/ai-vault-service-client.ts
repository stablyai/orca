import type { ChildProcess } from 'node:child_process'
import type { AiVaultListResult } from '../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../shared/ai-vault-session-title'
import type { SshAiVaultRelayListParams } from '../shared/ssh-ai-vault-relay'
import {
  RELAY_AI_VAULT_MAX_CALLS,
  RELAY_AI_VAULT_IDLE_TIMEOUT_MS,
  RELAY_AI_VAULT_READY_TIMEOUT_MS,
  RELAY_AI_VAULT_SCAN_TIMEOUT_MS,
  RELAY_AI_VAULT_TITLE_TIMEOUT_MS,
  armRelayAiVaultCancellationTimeout,
  createRelayAiVaultServiceCall,
  relayAiVaultAbortError,
  relayAiVaultError,
  RelayAiVaultIdleRetirement,
  requeueRelayAiVaultServiceStart,
  retireRelayAiVaultServiceChild,
  settleRelayAiVaultServiceCall,
  shutdownRelayAiVaultServiceChild,
  type RelayAiVaultServiceApi,
  type RelayAiVaultServiceCall,
  type RelayAiVaultServiceClientOptions
} from './ai-vault-service-client-state'
import {
  RELAY_AI_VAULT_SERVICE_PROTOCOL,
  isRelayAiVaultServiceChildMessage,
  type RelayAiVaultServiceChildMessage,
  type RelayAiVaultServiceInit,
  type RelayAiVaultServiceLane,
  type RelayAiVaultServiceRequest
} from './ai-vault-service-protocol'
import { RelayAiVaultRestartPolicy } from './ai-vault-service-restart-policy'
import { relayLogLine } from './relay-diagnostic-log'

export class RelayAiVaultServiceClient implements RelayAiVaultServiceApi {
  private child: ChildProcess | null = null
  private ready: Promise<ChildProcess> | null = null
  private readyReject: ((error: Error) => void) | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private readonly active = new Map<RelayAiVaultServiceLane, RelayAiVaultServiceCall>()
  private readonly queue: RelayAiVaultServiceCall[] = []
  private nextId = 1
  private readonly restartPolicy: RelayAiVaultRestartPolicy
  private readonly idleRetirement = new RelayAiVaultIdleRetirement()
  private disposed = false

  constructor(private readonly options: RelayAiVaultServiceClientOptions) {
    this.restartPolicy = new RelayAiVaultRestartPolicy(options.now)
  }

  listSessions(
    params: SshAiVaultRelayListParams,
    signal?: AbortSignal
  ): Promise<AiVaultListResult> {
    return this.request({ type: 'request', id: this.nextId++, operation: 'list', params }, signal)
  }

  resolveSessionTitles(
    requests: AiVaultSessionTitleRequest[],
    signal?: AbortSignal
  ): Promise<AiVaultSessionTitlesResult> {
    return this.request(
      { type: 'request', id: this.nextId++, operation: 'titles', requests },
      signal
    )
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.idleRetirement.clear()
    this.clearReadyTimer()
    this.restartPolicy.dispose()
    const error = new Error('Relay AI Vault service was disposed.')
    for (const call of [...this.active.values(), ...this.queue.splice(0)]) {
      settleRelayAiVaultServiceCall(call, error)
    }
    this.active.clear()
    const child = this.detachChild()
    if (child) {
      await shutdownRelayAiVaultServiceChild(child)
    }
  }

  private request<T extends AiVaultListResult | AiVaultSessionTitlesResult>(
    request: RelayAiVaultServiceRequest,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Relay AI Vault service was disposed.'))
    }
    if (signal?.aborted) {
      return Promise.reject(relayAiVaultAbortError())
    }
    if (this.queue.length + this.active.size >= RELAY_AI_VAULT_MAX_CALLS) {
      return Promise.reject(new Error('Relay AI Vault service queue is full.'))
    }
    return new Promise<T>((resolve, reject) => {
      const call = createRelayAiVaultServiceCall({
        request,
        signal,
        resolve: resolve as RelayAiVaultServiceCall['resolve'],
        reject
      })
      if (signal) {
        call.onAbort = () => this.cancel(call)
        signal.addEventListener('abort', call.onAbort, { once: true })
      }
      this.queue.push(call)
      this.idleRetirement.clear()
      this.pump()
    })
  }

  private pump(): void {
    if (this.disposed || this.restartPolicy.restartScheduled) {
      return
    }
    for (const lane of ['cache', 'interactive'] as const) {
      if (this.active.has(lane)) {
        continue
      }
      const index = this.queue.findIndex((call) => call.lane === lane)
      if (index === -1) {
        continue
      }
      const call = this.queue.splice(index, 1)[0]!
      this.active.set(lane, call)
      void this.ensureChild(call.forceStart).then(
        (child) => this.sendCall(child, call),
        (error: Error) => {
          if (this.active.get(lane) !== call) {
            return
          }
          this.active.delete(lane)
          this.retryStartOrSettle(call, error)
          this.pump()
        }
      )
    }
    this.scheduleIdleIfNeeded()
  }

  private sendCall(child: ChildProcess, call: RelayAiVaultServiceCall): void {
    if (this.active.get(call.lane) !== call || call.settled) {
      return
    }
    const timeout =
      call.request.operation === 'list'
        ? RELAY_AI_VAULT_SCAN_TIMEOUT_MS
        : RELAY_AI_VAULT_TITLE_TIMEOUT_MS
    call.timer = setTimeout(
      () => this.onFault(new Error(`Relay AI Vault service timed out after ${timeout}ms.`)),
      timeout
    )
    call.timer.unref?.()
    call.sent = true
    child.send(call.request)
  }

  private retryStartOrSettle(call: RelayAiVaultServiceCall, error: Error): void {
    if (this.disposed || !requeueRelayAiVaultServiceStart(call, this.queue)) {
      settleRelayAiVaultServiceCall(call, error)
    }
  }

  private ensureChild(forceStart: boolean): Promise<ChildProcess> {
    if (this.child && !this.ready) {
      return Promise.resolve(this.child)
    }
    if (this.ready) {
      return this.ready
    }
    const startError = this.restartPolicy.startError(forceStart)
    if (startError) {
      return Promise.reject(startError)
    }
    let child: ChildProcess
    try {
      child = this.options.processFactory()
    } catch (error) {
      return Promise.reject(relayAiVaultError(error))
    }
    this.child = child
    this.ready = new Promise<ChildProcess>((resolve, reject) => {
      this.readyReject = reject
      // Why: held on the instance so a crash before ready cannot leave the deadline
      // armed, where it would later fault the healthy replacement sidecar.
      this.readyTimer = setTimeout(
        () => this.onFault(new Error('Relay AI Vault service did not become ready.')),
        RELAY_AI_VAULT_READY_TIMEOUT_MS
      )
      this.readyTimer.unref?.()
      child.on('message', (message) => {
        if (isRelayAiVaultServiceChildMessage(message) && message.type === 'ready') {
          this.clearReadyTimer()
          this.ready = null
          this.readyReject = null
          resolve(child)
          return
        }
        this.onMessage(message)
      })
    })
    child.on('error', (error) => this.onFault(error))
    child.on('disconnect', () => this.onFault(new Error('Relay AI Vault service disconnected.')))
    child.on('exit', (code) => this.onFault(new Error(`Relay AI Vault service exited (${code}).`)))
    child.stderr?.on('data', (chunk: Buffer) =>
      relayLogLine(`[relay-ai-vault-service] ${String(chunk).trimEnd()}`)
    )
    child.send({
      type: 'init',
      protocol: RELAY_AI_VAULT_SERVICE_PROTOCOL,
      ...this.options.init
    } satisfies RelayAiVaultServiceInit)
    return this.ready
  }

  private onMessage(raw: unknown): void {
    if (!isRelayAiVaultServiceChildMessage(raw)) {
      this.onFault(new Error('Relay AI Vault service sent a malformed message.'))
      return
    }
    const message = raw as RelayAiVaultServiceChildMessage
    if (message.type === 'ready') {
      return
    }
    const call = [...this.active.values()].find((entry) => entry.request.id === message.id)
    if (!call) {
      return
    }
    this.active.delete(call.lane)
    settleRelayAiVaultServiceCall(
      call,
      message.type === 'error' ? new Error(message.message) : message.value
    )
    this.pump()
  }

  private cancel(call: RelayAiVaultServiceCall): void {
    const index = this.queue.indexOf(call)
    if (index !== -1) {
      this.queue.splice(index, 1)
      settleRelayAiVaultServiceCall(call, relayAiVaultAbortError())
      this.pump()
      return
    }
    if (this.active.get(call.lane) === call) {
      // Why: a call cancelled before it reached the sidecar gets no acknowledgement,
      // so waiting on one would kill a healthy sidecar and stall the lane.
      if (!call.sent) {
        this.active.delete(call.lane)
        settleRelayAiVaultServiceCall(call, relayAiVaultAbortError())
        this.pump()
        return
      }
      this.child?.send({ type: 'cancel', id: call.request.id })
      settleRelayAiVaultServiceCall(call, relayAiVaultAbortError())
      armRelayAiVaultCancellationTimeout(call, () =>
        this.onFault(new Error('Relay AI Vault service did not cancel within 2000ms.'))
      )
    }
  }

  private onFault(error: Error): void {
    if (!this.child) {
      return
    }
    this.idleRetirement.clear()
    this.detachChild()?.kill()
    this.clearReadyTimer()
    this.readyReject?.(error)
    this.readyReject = null
    this.ready = null
    const active = [...this.active.values()]
    this.active.clear()
    for (const call of active) {
      this.retryStartOrSettle(call, error)
    }
    this.restartPolicy.recordFault()
    if (this.queue.length > 0 && !this.disposed) {
      this.restartPolicy.scheduleRestart(() => this.pump())
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
  }

  private detachChild(): ChildProcess | null {
    const child = this.child
    this.child = null
    child?.removeAllListeners()
    return child
  }

  private scheduleIdleIfNeeded(): void {
    this.idleRetirement.schedule(
      this.active.size > 0 || this.queue.length > 0 || !this.child,
      this.options.idleTimeoutMs ?? RELAY_AI_VAULT_IDLE_TIMEOUT_MS,
      () => {
        const child = this.detachChild()
        if (child) {
          retireRelayAiVaultServiceChild(child)
        }
      }
    )
  }
}
