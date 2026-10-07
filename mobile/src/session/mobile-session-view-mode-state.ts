import type {
  MobileSessionView,
  SessionViewOverridesPreference
} from '../storage/session-view-preferences'

export type ViewOverridesState = {
  hostId: string
  worktreeId: string
  overrides: Map<string, MobileSessionView>
  loaded: boolean
}

export type MobileSessionViewModeController = {
  isTabChatView: (tabId: string) => boolean
  toggleTabChatView: (tabId: string) => void
}

export type ViewOverridesRuntime = {
  hostId: string
  worktreeId: string
  loadPromise: Promise<SessionViewOverridesPreference>
  currentOverrides: Map<string, MobileSessionView>
  mutationRevisions: Map<string, number>
}

export type PendingHostViewWrite = {
  hostId: string
  worktreeId: string
  source?: object
  viewMode: MobileSessionView
  token: number
  accepted: boolean
  acknowledgedPublication?: { epoch: string; version: number }
}

export type MobileSessionTabViewModeBridge = {
  hostViewSource?: object
  readHostViewPublication?: () => { epoch: string | null; version: number }
  readHostViewMode: (tabId: string) => MobileSessionView | undefined
  writeHostViewMode:
    | ((
        tabId: string,
        view: MobileSessionView
      ) => Promise<{ publicationEpoch?: string; snapshotVersion?: number } | void>)
    | null
  onHostViewModeWriteError?: (error: unknown) => void
}

export function createViewOverridesRuntime(
  hostId: string,
  worktreeId: string,
  load: (hostId: string, worktreeId: string) => Promise<SessionViewOverridesPreference>
): ViewOverridesRuntime {
  return {
    hostId,
    worktreeId,
    loadPromise: load(hostId, worktreeId),
    currentOverrides: new Map(),
    mutationRevisions: new Map()
  }
}

export function isOverrideScope(
  state: ViewOverridesState,
  hostId: string,
  worktreeId: string
): boolean {
  return state.hostId === hostId && state.worktreeId === worktreeId
}

export function mergeOverrides(
  persisted: ReadonlyMap<string, MobileSessionView>,
  current: ReadonlyMap<string, MobileSessionView>
): Map<string, MobileSessionView> {
  const merged = new Map(persisted)
  for (const [tabId, view] of current) {
    merged.set(tabId, view)
  }
  return merged
}

export function reachesPublication(
  current: { epoch: string | null; version: number } | undefined,
  target: { epoch: string; version: number }
): boolean {
  return (
    current !== undefined && current.epoch === target.epoch && current.version >= target.version
  )
}

export function isPendingHostViewWriteSettled(
  write: PendingHostViewWrite,
  currentPublication: { epoch: string | null; version: number } | undefined,
  currentView: MobileSessionView | undefined
): boolean {
  return (
    write.accepted &&
    ((write.acknowledgedPublication &&
      reachesPublication(currentPublication, write.acknowledgedPublication)) ||
      (!write.acknowledgedPublication && currentView === write.viewMode))
  )
}
