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

export type ViewOverridesRuntime = {
  hostId: string
  worktreeId: string
  loadPromise: Promise<SessionViewOverridesPreference>
  currentOverrides: Map<string, MobileSessionView>
  mutationRevisions: Map<string, number>
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
