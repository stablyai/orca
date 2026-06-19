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
  relativePath: string
): T | null {
  return (
    tabs.find(
      (tab) =>
        tab.type !== 'browser' &&
        tab.type !== 'terminal' &&
        tab.mode !== 'diff' &&
        tab.relativePath === relativePath
    ) ?? null
  )
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
