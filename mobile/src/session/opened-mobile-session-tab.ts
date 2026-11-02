export type OpenedMobileSessionTabActivationState = {
  activated: boolean
  activationSeq: number
  latestActivationSeq: number
  sourceTerminalHandle: string | null
  activeTerminalHandle: string | null
  sourceSessionTabId?: string | null
  activeSessionTabId?: string | null
  activeTabType: string | null
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
  return !state.activated && state.activationSeq === state.latestActivationSeq && sourceStillActive
}
