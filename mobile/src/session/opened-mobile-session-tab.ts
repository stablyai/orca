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
  sourceTerminalHandle: string
  activeTerminalHandle: string | null
  activeTabType: string | null
}

export type ActivateOpenedMobileSessionTabOptions<T extends OpenedMobileSessionTabCandidate> = {
  relativePath: string
  fetchSessionTabs: () => Promise<void>
  getTabs: () => readonly T[]
  getActiveTabId: () => string | null
  getActivationState: () => OpenedMobileSessionTabActivationState
  switchSessionTab: (tab: T) => boolean
}

export type RefreshOpenedMobileSessionTabsOptions = {
  getCurrentRefresh: () => Promise<void> | null
  refreshSessionTabs: () => Promise<void>
}

export async function refreshOpenedMobileSessionTabs(
  options: RefreshOpenedMobileSessionTabsOptions
): Promise<void> {
  const currentRefresh = options.getCurrentRefresh()
  if (currentRefresh) {
    await currentRefresh
  }
  await options.refreshSessionTabs()
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

// Activation for a diff tab opened by tapping a changed file in the docked
// source-control panel. Unlike the terminal path there is no "source terminal"
// to guard against; instead we cancel if the user moved to a different tab
// after the tap (no focus steal) and treat the diff already being active as
// success. Returns true once activation is settled so retries can stop.
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
  // The post-open snapshot may already show the opened diff as active; that is
  // success, not a focus steal, so settle without re-activating.
  if (activeTabId === opened.id) {
    return true
  }
  // No focus steal: if the user moved to a different tab after the tap, leave
  // them there instead of yanking focus back to the diff.
  if (activeTabId !== options.activeTabIdAtTap) {
    return false
  }
  options.switchSessionTab(opened)
  return true
}

export function shouldActivateOpenedMobileSessionTab(
  state: OpenedMobileSessionTabActivationState
): boolean {
  return (
    !state.activated &&
    state.activationSeq === state.latestActivationSeq &&
    state.activeTabType === 'terminal' &&
    state.activeTerminalHandle === state.sourceTerminalHandle
  )
}

export async function activateOpenedMobileSessionTab<T extends OpenedMobileSessionTabCandidate>(
  options: ActivateOpenedMobileSessionTabOptions<T>
): Promise<boolean> {
  if (!shouldActivateOpenedMobileSessionTab(options.getActivationState())) {
    return false
  }
  await options.fetchSessionTabs()
  if (!shouldActivateOpenedMobileSessionTab(options.getActivationState())) {
    return false
  }
  const opened = findOpenedMobileSessionTab(options.getTabs(), options.relativePath)
  if (!opened) {
    return false
  }
  if (options.getActiveTabId() === opened.id) {
    return true
  }
  return options.switchSessionTab(opened)
}
