export type OpenedMobileSessionTabCandidate = {
  id: string
  type: string
  mode?: unknown
  relativePath?: unknown
}

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

export function findOpenedMobileSessionTab<T extends OpenedMobileSessionTabCandidate>(
  tabs: readonly T[],
  relativePath: string,
  options: { preferMode?: 'diff' | 'edit' } = {}
): T | null {
  const matches = tabs.filter(
    (tab) => tab.type !== 'browser' && tab.type !== 'terminal' && tab.relativePath === relativePath
  )
  if (matches.length === 0) {
    return null
  }
  if (options.preferMode === 'diff') {
    return matches.find((tab) => tab.mode === 'diff') ?? matches[0] ?? null
  }
  return matches.find((tab) => tab.mode !== 'diff') ?? matches[0] ?? null
}

export type OpenedSourceControlDiffActivationState = {
  activated: boolean
  activationSeq: number
  latestActivationSeq: number
}

export type ActivateOpenedSourceControlDiffTabOptions<T extends OpenedMobileSessionTabCandidate> = {
  relativePath: string
  activeTabIdAtTap: string | null
  fetchSessionTabs: () => Promise<void>
  getTabs: () => readonly T[]
  getActiveTabId: () => string | null
  getActivationState: () => OpenedSourceControlDiffActivationState
  switchSessionTab: (tab: T) => void
}

// Diff opens have no source terminal; settle already-active tabs and stop activation if the user changed tabs after the tap.
export async function activateOpenedSourceControlDiffTab<T extends OpenedMobileSessionTabCandidate>(
  options: ActivateOpenedSourceControlDiffTabOptions<T>
): Promise<boolean> {
  const isSuperseded = (): boolean => {
    const state = options.getActivationState()
    return state.activated || state.activationSeq !== state.latestActivationSeq
  }
  if (isSuperseded()) {
    return false
  }
  await options.fetchSessionTabs()
  if (isSuperseded()) {
    return false
  }
  const opened = findOpenedMobileSessionTab(options.getTabs(), options.relativePath, {
    preferMode: 'diff'
  })
  if (!opened) {
    return false
  }
  const activeTabId = options.getActiveTabId()
  // Already-active diff tabs settle without another activation.
  if (activeTabId === opened.id) {
    return true
  }
  // A newer user selection must win over this asynchronous open.
  if (activeTabId !== options.activeTabIdAtTap) {
    return false
  }
  options.switchSessionTab(opened)
  return true
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
