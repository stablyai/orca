import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'
import type { AppState } from '@/store/types'

/**
 * Main changed these workspaces' saved tabs after this window read them (a restart's repair of a
 * crashed switch, already saved): they are read again, only they, before their terminals
 * reconnect, so this window shows and later saves what main wrote.
 */
export async function rehydrateRepairedWorkspaces(
  workspaceKeys: string[] | void,
  actions: Pick<AppState, 'hydrateWorkspaceSession' | 'hydrateTabsSession'>,
  options: WorkspaceSessionHydrationOptions
): Promise<void> {
  if (!workspaceKeys?.length) {
    return
  }
  const session = await window.api.session.get()
  const scoped = { ...options, replaceWorkspaceKeys: workspaceKeys }
  actions.hydrateWorkspaceSession(session, scoped)
  actions.hydrateTabsSession(session, scoped)
}
