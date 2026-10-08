import { isAbsolute } from 'node:path'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { dispatchPerforceOperation } from '../../shared/perforce/perforce-operations'
import { runWithDesktopPerforceSettings } from '../perforce/perforce-desktop-settings'
import { resolvePerforceBackend } from '../perforce/perforce-ssh-backend'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { registerPerforceDescriptionGeneration } from './perforce-description-generation'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'

type WorktreeArgs = Record<string, unknown> & { worktreePath: string; connectionId?: string }

export function registerPerforceHandlers(
  store: Store,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  registerPerforceDescriptionGeneration(store, commitMessageAgentEnv)

  ipcMain.handle('perforce:run', async (_event, operation: unknown, args: WorktreeArgs) => {
    // Why: SSH paths belong to the remote host; only local paths are checked against registered roots.
    const cwd = args.connectionId
      ? args.worktreePath
      : await resolveRegisteredWorktreePath(args.worktreePath, store)
    return runWithDesktopPerforceSettings(store, () =>
      dispatchPerforceOperation(resolvePerforceBackend(args.connectionId), operation, cwd, args)
    )
  })

  // Why: Add Folder asks before the folder is a project, so it has no registered root yet. Only
  // `p4 info` runs there, so this widens no file access.
  ipcMain.handle(
    'perforce:detectFolder',
    async (_event, args: { folderPath?: unknown; connectionId?: unknown }) => {
      const connectionId =
        typeof args?.connectionId === 'string' && args.connectionId ? args.connectionId : undefined
      const folderPath = args?.folderPath
      if (typeof folderPath !== 'string' || (!connectionId && !isAbsolute(folderPath))) {
        throw new Error('A Perforce folder check needs an absolute folder path.')
      }
      return runWithDesktopPerforceSettings(store, () =>
        resolvePerforceBackend(connectionId).detect(folderPath)
      )
    }
  )
}
