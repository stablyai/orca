import type { ConnectionState } from '../transport/connection/connection-state'

type MobileTerminalInputGateOptions = {
  readonly connState: ConnectionState
  readonly activeHandle: string | null
  readonly activeSessionTabType: string | null | undefined
}

type MobileTerminalInputGate = {
  // An active terminal to type into, even before the connection allows sending.
  readonly canCompose: boolean
  readonly canSend: boolean
}

export function resolveMobileTerminalInputGate({
  connState,
  activeHandle,
  activeSessionTabType
}: MobileTerminalInputGateOptions): MobileTerminalInputGate {
  const canCompose =
    activeHandle != null &&
    activeSessionTabType !== 'markdown' &&
    activeSessionTabType !== 'file' &&
    activeSessionTabType !== 'browser'
  return { canCompose, canSend: canCompose && connState === 'connected' }
}
