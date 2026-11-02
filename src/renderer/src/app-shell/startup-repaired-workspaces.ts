import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'

type HydratedTabs = Pick<AppState, 'unifiedTabsByWorktree' | 'tabsByWorktree'>

/** This window's tabs as hydration left them, to tell which workspaces the user changed since. */
export function hydratedTabsSnapshot(): HydratedTabs {
  const { unifiedTabsByWorktree, tabsByWorktree } = useAppStore.getState()
  return { unifiedTabsByWorktree, tabsByWorktree }
}

/**
 * Main changed these workspaces' saved tabs after this window read them (a restart's repair of a
 * crashed switch, already saved): they are read again, only they, before their terminals
 * reconnect, so this window shows and later saves what main wrote. A workspace whose tabs the user
 * changed since hydration keeps them: its stopped terminal stays and the chat opens beside it.
 */
export async function rehydrateRepairedWorkspaces(
  workspaceKeys: string[] | void,
  hydrated: HydratedTabs,
  actions: Pick<AppState, 'hydrateWorkspaceSession' | 'hydrateTabsSession'>,
  options: WorkspaceSessionHydrationOptions
): Promise<void> {
  const now = useAppStore.getState()
  const untouched = (workspaceKeys ?? []).filter(
    (key) =>
      now.unifiedTabsByWorktree[key] === hydrated.unifiedTabsByWorktree[key] &&
      now.tabsByWorktree[key] === hydrated.tabsByWorktree[key]
  )
  if (untouched.length === 0) {
    return
  }
  const session = await window.api.session.get()
  const scoped = { ...options, replaceWorkspaceKeys: untouched }
  actions.hydrateWorkspaceSession(session, scoped)
  actions.hydrateTabsSession(session, scoped)
}
