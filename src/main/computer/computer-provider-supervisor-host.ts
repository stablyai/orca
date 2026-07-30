import {
  COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
  isComputerProviderSupervisorRequest,
  type ComputerProviderSupervisorMessage,
  type ComputerProviderSupervisorRequest,
  type ComputerProviderSupervisorResponse
} from './computer-provider-supervisor-protocol'
import { MacOSNativeProviderSupervisor } from './macos-native-provider-supervisor'

type SupervisorMessageSender = (message: ComputerProviderSupervisorMessage) => void
type SupervisorResponsePayload =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }

export class ComputerProviderSupervisorHost {
  private sender: SupervisorMessageSender | null = null
  private readonly macOS: MacOSNativeProviderSupervisor

  constructor(macOS?: MacOSNativeProviderSupervisor) {
    this.macOS = macOS ?? new MacOSNativeProviderSupervisor((event) => this.sender?.(event))
  }

  attach(sender: SupervisorMessageSender): void {
    this.sender = sender
  }

  handle(message: unknown): boolean {
    if (!this.sender || !isComputerProviderSupervisorRequest(message)) {
      return false
    }
    void this.dispatch(message).then(
      (result) => this.send({ id: message.id, ok: true, result }),
      (error) =>
        this.send({
          id: message.id,
          ok: false,
          error: errorPayload(error)
        })
    )
    return true
  }

  shutdown(): void {
    this.sender = null
    this.macOS.shutdown()
  }

  private async dispatch(request: ComputerProviderSupervisorRequest): Promise<unknown> {
    switch (request.method) {
      case 'macos.start':
        return this.macOS.start()
      case 'macos.claim':
        this.macOS.claim(request.params.sessionId)
        return { claimed: true }
      case 'macos.release':
        this.macOS.release(request.params.sessionId)
        return { released: true }
    }
  }

  private send(response: SupervisorResponsePayload): void {
    this.sender?.({
      channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
      kind: 'response',
      ...response
    } as ComputerProviderSupervisorResponse)
  }
}

function errorPayload(error: unknown): { code: string; message: string } {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return { code: (error as { code: string }).code, message: error.message }
  }
  return {
    code: 'accessibility_error',
    message: error instanceof Error ? error.message : String(error)
  }
}
