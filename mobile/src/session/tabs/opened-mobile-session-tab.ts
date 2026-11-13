export type OpenedMobileSessionTabActivationState = {
  activated: boolean
  activationSeq: number
  latestActivationSeq: number
  sourceTerminalHandle: string | null
  activeTerminalHandle: string | null
  sourceSessionTabId?: string | null
  activeSessionTabId?: string | null
  activeTabType: string | null
  sourceNavigationGeneration?: number
  activeNavigationGeneration?: number
  // False once the host, client or its authority generation changed after the tap; absent means unfenced.
  sourceAuthorityCurrent?: boolean
}

export function shouldActivateOpenedMobileSessionTab(
  state: OpenedMobileSessionTabActivationState
): boolean {
  const sourceStillActive =
    state.activeTabType === 'agent-session'
      ? state.sourceSessionTabId !== null &&
        state.sourceSessionTabId !== undefined &&
        state.activeSessionTabId === state.sourceSessionTabId
      : state.activeTabType === 'terminal' &&
        state.sourceTerminalHandle !== null &&
        state.activeTerminalHandle === state.sourceTerminalHandle
  return (
    !state.activated &&
    state.activationSeq === state.latestActivationSeq &&
    state.sourceNavigationGeneration === state.activeNavigationGeneration &&
    state.sourceAuthorityCurrent !== false &&
    sourceStillActive
  )
}
