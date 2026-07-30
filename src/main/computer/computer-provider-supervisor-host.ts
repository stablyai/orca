import {
  COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
  isComputerProviderSupervisorRequest,
  type ComputerProviderSupervisorMessage,
  type ComputerProviderSupervisorRequest,
  type ComputerProviderSupervisorResponse
} from './computer-provider-supervisor-protocol'
import { DesktopScriptProviderSupervisor } from './desktop-script-provider-supervisor'
import { MacOSNativeProviderSupervisor } from './macos-native-provider-supervisor'

type SupervisorMessageSender = (message: ComputerProviderSupervisorMessage) => void
type SupervisorResponsePayload =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }

export class ComputerProviderSupervisorHost {
  private sender: SupervisorMessageSender | null = null
  private ownerProcessId: number | null = null
  private ownerGeneration = 0
  private readonly macOS: MacOSNativeProviderSupervisor
  private readonly desktop: DesktopScriptProviderSupervisor

  constructor(macOS?: MacOSNativeProviderSupervisor, desktop?: DesktopScriptProviderSupervisor) {
    this.macOS = macOS ?? new MacOSNativeProviderSupervisor((event) => this.sender?.(event))
    this.desktop = desktop ?? new DesktopScriptProviderSupervisor()
  }

  attach(sender: SupervisorMessageSender, ownerProcessId: number): void {
    if (!Number.isInteger(ownerProcessId) || ownerProcessId <= 0 || ownerProcessId > 0x7fffffff) {
      throw new Error('computer provider owner process did not report a valid pid')
    }
    this.ownerGeneration++
    this.sender = sender
    this.ownerProcessId = ownerProcessId
  }

  handle(message: unknown): boolean {
    if (
      !this.sender ||
      this.ownerProcessId === null ||
      !isComputerProviderSupervisorRequest(message)
    ) {
      return false
    }
    const ownerGeneration = this.ownerGeneration
    const ownerProcessId = this.ownerProcessId
    void this.dispatch(message, ownerProcessId).then(
      (result) => this.send(ownerGeneration, { id: message.id, ok: true, result }),
      (error) =>
        this.send(ownerGeneration, {
          id: message.id,
          ok: false,
          error: errorPayload(error)
        })
    )
    return true
  }

  shutdown(): void {
    this.ownerGeneration++
    this.sender = null
    this.ownerProcessId = null
    this.macOS.shutdown()
    this.desktop.shutdown()
  }

  private async dispatch(
    request: ComputerProviderSupervisorRequest,
    ownerProcessId: number
  ): Promise<unknown> {
    switch (request.method) {
      case 'macos.start':
        return this.macOS.start(ownerProcessId)
      case 'macos.claim':
        this.macOS.claim(request.params.sessionId)
        return { claimed: true }
      case 'macos.release':
        this.macOS.release(request.params.sessionId)
        return { released: true }
      case 'desktop.execute':
        return this.desktop.execute(request.params.request)
    }
  }

  private send(ownerGeneration: number, response: SupervisorResponsePayload): void {
    if (ownerGeneration !== this.ownerGeneration) {
      return
    }
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
