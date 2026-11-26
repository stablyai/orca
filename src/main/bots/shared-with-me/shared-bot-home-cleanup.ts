// Before a shared agent was a paired server's agent, this computer kept a home of its own for each
// one: a folder workspace in the Bots group over `<userData>/shared-agents/<shareId>`. Its chats now
// open in the agent's home on its owner's computer, so those homes go, once, at startup.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SharedBotHostStore } from './shared-bot-host-store'

export type SharedBotHomeCleanupDeps = {
  userDataPath: string
  store: SharedBotHostStore
  folderWorkspaceIds: () => readonly string[]
  /** The app's own delete: its tabs, terminals and session state go with it. */
  deleteFolderWorkspace: (id: string) => Promise<unknown>
}

/** Removes each kept share's old home and the folder they lived in; a no-op once they are gone. */
export async function removeOldSharedBotHomes(deps: SharedBotHomeCleanupDeps): Promise<void> {
  const workspaces = new Set(deps.folderWorkspaceIds())
  for (const entry of deps.store.list()) {
    const { homeWorkspaceId, ...rest } = entry
    if (homeWorkspaceId === undefined) {
      continue
    }
    if (workspaces.has(homeWorkspaceId)) {
      try {
        await deps.deleteFolderWorkspace(homeWorkspaceId)
      } catch (error) {
        // Kept, so the next start tries again.
        console.warn('[shared-agents] could not remove an old shared agent home', error)
        continue
      }
    }
    deps.store.put(rest)
  }
  await rm(join(deps.userDataPath, 'shared-agents'), { recursive: true, force: true })
}
