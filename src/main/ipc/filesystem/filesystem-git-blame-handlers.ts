import { ipcMain } from 'electron'
import { GIT_BLAME_INDEX_CONTENTS, type GitBlameResult } from '../../../shared/git-blame'
import { getFileBlame } from '../../git/blame'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import {
  validateFullGitObjectId,
  validateGitRelativeFilePath
} from '../filesystem-path-containment'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

function resolveBlameContentsSource(
  contentsSource: string | undefined
): typeof GIT_BLAME_INDEX_CONTENTS | undefined {
  return contentsSource === GIT_BLAME_INDEX_CONTENTS ? GIT_BLAME_INDEX_CONTENTS : undefined
}

export function registerFilesystemGitBlameHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:blame',
    async (
      _event,
      args: {
        worktreePath: string
        filePath: string
        connectionId?: string
        revision?: string
        contentsSource?: string
      }
    ): Promise<GitBlameResult> => {
      const revision =
        args.revision && args.revision !== 'HEAD'
          ? validateFullGitObjectId(args.revision, 'revision')
          : args.revision
      const contentsSource = resolveBlameContentsSource(args.contentsSource)
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        // Why: same relative-path containment as local git:blame; worktree
        // ownership stays on the relay, matching git.diff / git.history.
        const filePath = validateGitRelativeFilePath(args.worktreePath, args.filePath)
        return provider.getBlame(args.worktreePath, filePath, revision, contentsSource)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getFileBlame(worktreePath, filePath, gitOptions, revision, contentsSource)
    }
  )
}
