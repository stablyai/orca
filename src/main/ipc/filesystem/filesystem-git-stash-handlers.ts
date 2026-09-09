import { ipcMain } from 'electron'
import type { GitStashCreateOptions, GitStashFile, GitStashSummary } from '../../../shared/git-stash'
import { applyStash, createStash, dropStash, listStashes, listStashFiles, popStash } from '../../git/stash'
import { getSshGitProvider, SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from '../../providers/ssh-git-dispatch'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { runCancellableStashRead } from './filesystem-cancellable-stash-read'

type StashTarget = { worktreePath: string; connectionId?: string }

export function registerFilesystemGitStashHandlers(context: FilesystemHandlerContext): void {
  const localTarget = async (worktreePath: string) => {
    const path = await resolveRegisteredWorktreePath(worktreePath, context.store)
    return { path, options: getLocalGitOptionsForRegisteredWorktree(context.store, worktreePath, path) }
  }
  const provider = (connectionId: string) => {
    const value = getSshGitProvider(connectionId)
    if (!value) {
      throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    return value
  }

  ipcMain.handle('git:stashList', async (event, args: StashTarget & { requestToken?: string }): Promise<GitStashSummary[]> => {
    return runCancellableStashRead(context.gitStashCancellations, event, args.requestToken, async (signal) => {
      if (args.connectionId) {
        return provider(args.connectionId).listStashes(args.worktreePath, { signal })
      }
      const target = await localTarget(args.worktreePath)
      return listStashes(target.path, { ...target.options, signal })
    })
  })
  ipcMain.handle('git:stashFiles', async (event, args: StashTarget & { ref: string; expectedCommitId: string; requestToken?: string }): Promise<GitStashFile[]> => {
    return runCancellableStashRead(context.gitStashCancellations, event, args.requestToken, async (signal) => {
      if (args.connectionId) {
        return provider(args.connectionId).listStashFiles(args.worktreePath, args, { signal })
      }
      const target = await localTarget(args.worktreePath)
      return listStashFiles(target.path, args, { ...target.options, signal })
    })
  })
  ipcMain.handle('git:stashCancel', (event, args: { requestToken: string }) => context.gitStashCancellations.cancel(event, args.requestToken))
  ipcMain.handle('git:stashCreate', async (_event, args: StashTarget & GitStashCreateOptions) => {
    if (args.connectionId) {
      return provider(args.connectionId).createStash(args.worktreePath, args)
    }
    const target = await localTarget(args.worktreePath)
    return createStash(target.path, args, target.options)
  })
  for (const [channel, method, local] of [
    ['git:stashApply', 'applyStash', applyStash],
    ['git:stashPop', 'popStash', popStash],
    ['git:stashDrop', 'dropStash', dropStash]
  ] as const) {
    ipcMain.handle(channel, async (_event, args: StashTarget & { ref: string; expectedCommitId: string }) => {
      if (args.connectionId) {
        return provider(args.connectionId)[method](args.worktreePath, args)
      }
      const target = await localTarget(args.worktreePath)
      return local(target.path, args, target.options)
    })
  }
}
