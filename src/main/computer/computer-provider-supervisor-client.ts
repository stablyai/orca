import {
  COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
  isComputerProviderSupervisorMessage,
  isStartedSupervisedMacOSProvider,
  type ComputerProviderSupervisorRequest,
  type StartedSupervisedMacOSProvider
} from './computer-provider-supervisor-protocol'
import { RuntimeClientError } from './runtime-client-error'

const SUPERVISOR_REQUEST_TIMEOUT_MS = 10_000
const MAX_EARLY_MACOS_TERMINATIONS = 32

type PendingSupervisorRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type MacOSSessionState = {
  termination: Promise<never>
  rejectTermination: (error: Error) => void
}

type SupervisorSend = (
  message: ComputerProviderSupervisorRequest,
  callback: (error: Error | null) => void
) => void

export type SupervisedMacOSProviderSession = StartedSupervisedMacOSProvider & {
  termination: Promise<never>
}

export class ComputerProviderSupervisorClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingSupervisorRequest>()
  private readonly macOSSessions = new Map<string, MacOSSessionState>()
  private readonly earlyMacOSTerminations = new Map<string, RuntimeClientError>()

  constructor(private readonly send: SupervisorSend) {}

  async startMacOSProvider(): Promise<SupervisedMacOSProviderSession> {
    const result = await this.request('macos.start', {})
    if (!isStartedSupervisedMacOSProvider(result)) {
      throw new RuntimeClientError(
        'accessibility_error',
        'computer provider supervisor returned an invalid macOS session'
      )
    }
    const state = this.createMacOSSessionState()
    this.macOSSessions.set(result.sessionId, state)
    const earlyTermination = this.earlyMacOSTerminations.get(result.sessionId)
    if (earlyTermination) {
      this.earlyMacOSTerminations.delete(result.sessionId)
      state.rejectTermination(earlyTermination)
    }
    return { ...result, termination: state.termination }
  }

  async claimMacOSProvider(sessionId: string): Promise<void> {
    await this.request('macos.claim', { sessionId })
  }

  async releaseMacOSProvider(sessionId: string): Promise<void> {
    try {
      await this.request('macos.release', { sessionId })
    } finally {
      this.macOSSessions.delete(sessionId)
      this.earlyMacOSTerminations.delete(sessionId)
    }
  }

  handleMessage(message: unknown): boolean {
    if (!isComputerProviderSupervisorMessage(message)) {
      return false
    }
    if (message.kind === 'event') {
      const error = new RuntimeClientError(message.error.code, message.error.message)
      const session = this.macOSSessions.get(message.sessionId)
      if (session) {
        session.rejectTermination(error)
      } else {
        if (
          !this.earlyMacOSTerminations.has(message.sessionId) &&
          this.earlyMacOSTerminations.size >= MAX_EARLY_MACOS_TERMINATIONS
        ) {
          const oldestSessionId = this.earlyMacOSTerminations.keys().next().value
          if (oldestSessionId) {
            this.earlyMacOSTerminations.delete(oldestSessionId)
          }
        }
        this.earlyMacOSTerminations.set(message.sessionId, error)
      }
      return true
    }

    const pending = this.pending.get(message.id)
    if (!pending) {
      return true
    }
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok) {
      pending.resolve(message.result)
    } else {
      pending.reject(new RuntimeClientError(message.error.code, message.error.message))
    }
    return true
  }

  shutdown(): void {
    const error = new RuntimeClientError(
      'accessibility_error',
      'computer provider supervisor channel shut down'
    )
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
    for (const session of this.macOSSessions.values()) {
      session.rejectTermination(error)
    }
    this.macOSSessions.clear()
    this.earlyMacOSTerminations.clear()
  }

  private request(
    method: ComputerProviderSupervisorRequest['method'],
    params: Record<string, unknown>
  ): Promise<unknown> {
    const id = this.nextId++
    const request = {
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'request',
      id,
      method,
      params
    } as ComputerProviderSupervisorRequest

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new RuntimeClientError(
            'action_timeout',
            `computer provider supervisor ${method} timed out`
          )
        )
      }, SUPERVISOR_REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send(request, (error) => {
          if (!error) {
            return
          }
          const pending = this.pending.get(id)
          if (!pending) {
            return
          }
          clearTimeout(pending.timer)
          this.pending.delete(id)
          pending.reject(new RuntimeClientError('accessibility_error', error.message))
        })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(
          new RuntimeClientError(
            'accessibility_error',
            error instanceof Error ? error.message : String(error)
          )
        )
      }
    })
  }

  private createMacOSSessionState(): MacOSSessionState {
    let rejectTermination = (_error: Error): void => {}
    const termination = new Promise<never>((_resolve, reject) => {
      rejectTermination = reject
    })
    void termination.catch(() => undefined)
    return { termination, rejectTermination }
  }
}

const client = new ComputerProviderSupervisorClient((message, callback) => {
  if (!process.send || !process.connected) {
    callback(new Error('computer provider supervisor IPC is unavailable'))
    return
  }
  process.send(message, callback)
})

export function startSupervisedMacOSProvider(): Promise<SupervisedMacOSProviderSession> {
  return client.startMacOSProvider()
}

export function claimSupervisedMacOSProvider(sessionId: string): Promise<void> {
  return client.claimMacOSProvider(sessionId)
}

export function releaseSupervisedMacOSProvider(sessionId: string): Promise<void> {
  return client.releaseMacOSProvider(sessionId)
}

export function handleComputerProviderSupervisorMessage(message: unknown): boolean {
  return client.handleMessage(message)
}

export function shutdownComputerProviderSupervisorClient(): void {
  client.shutdown()
}
