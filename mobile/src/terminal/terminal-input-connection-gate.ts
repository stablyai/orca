import type { ConnectionState } from '../transport/types'

type MobileTerminalInputGateOptions = {
  readonly connState: ConnectionState
  readonly activeHandle: string | null
  readonly activeSessionTabType: string | null | undefined
}

type MobileTerminalInputGate = {
  // Composing is local; preserve typed text through connection outages.
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
