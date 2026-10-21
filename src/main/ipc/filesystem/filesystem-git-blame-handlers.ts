import { ipcMain } from 'electron'
import { GIT_BLAME_INDEX_CONTENTS, type GitBlameResult } from '../../../shared/git-blame'
import { getFileBlame } from '../../git/blame'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import {
  validateFullGitObjectId,
  validateGitRelativeFilePath
} from '../filesystem-path-containment'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

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
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
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
