import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { resolvePerforceBackend } from '../perforce/perforce-ssh-backend'
import {
  generatePerforceDescription,
  type PerforceDescriptionChangelist
} from '../perforce/perforce-description-generation'
import {
  desktopPerforceSettings,
  runWithDesktopPerforceSettings
} from '../perforce/perforce-desktop-settings'
import type { GenerateCommitMessageResult } from '../text-generation/commit-message-text-generation'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'

type GenerateArgs = {
  worktreePath: string
  connectionId?: string
  changelist: PerforceDescriptionChangelist
  filePaths: string[]
}

/** Drafts a changelist description for a workspace on this desktop or one of its SSH hosts. */
export function registerPerforceDescriptionGeneration(
  store: Store,
  agentEnvironment: CommitMessageAgentEnvironmentResolvers | undefined
): void {
  ipcMain.handle(
    'perforce:generateDescription',
    (_event, args: GenerateArgs): Promise<GenerateCommitMessageResult> =>
      runWithDesktopPerforceSettings(store, async () => {
        const { connectionId } = args
        // Why: SSH paths belong to the remote host; only local paths are checked against registered roots.
        const cwd = connectionId
          ? args.worktreePath
          : await resolveRegisteredWorktreePath(args.worktreePath, store)
        const wslDistro = connectionId
          ? undefined
          : getLocalGitOptionsForRegisteredWorktree(store, args.worktreePath, cwd).wslDistro
        return generatePerforceDescription({
          settings: store.getSettings(),
          perforce: desktopPerforceSettings(store),
          backend: resolvePerforceBackend(connectionId),
          cwd,
          changelist: args.changelist,
          filePaths: args.filePaths,
          agentHost: connectionId
            ? { kind: 'ssh', connectionId }
            : { kind: 'local', ...(wslDistro ? { wslDistro } : {}), agentEnvironment }
        })
      })
  )
}
