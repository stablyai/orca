import { ipcMain } from 'electron'
import {
  stageFile,
  unstageFile,
  discardChanges,
  bulkDiscardChanges,
  bulkStageFiles,
  bulkUnstageFiles,
  stageWorktreeChanges
} from '../../git/status'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import {
  getLocalGitOptionsForRegisteredWorktree,
  getLocalRepoForRegisteredWorktree
} from '../local-worktree-runtime-options'
import { getWorktreeSharedLinkPaths } from '../../git/worktree-shared-directories'
import { validateGitRelativeFilePath } from './filesystem-path-containment'
import { resolveGitActionPath } from './git-remote/submodule-action-target'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { parseGitStageWorktreeScope } from '../../../shared/git-stage-worktree-scope'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'

export function registerFilesystemGitIndexHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:stage',
    async (
      _event,
      args: {
        worktreePath: string
        filePath: string
        connectionId?: string
        submodulePath?: string
      }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const registeredPath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        registeredPath
      )
      const worktreePath = await resolveGitActionPath(args, registeredPath, gitOptions)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await stageFile(worktreePath, filePath, { ...gitOptions, admissionTier: 'interactive' })
    }
  )

  ipcMain.handle(
    'git:unstage',
    async (
      _event,
      args: {
        worktreePath: string
        filePath: string
        connectionId?: string
        submodulePath?: string
      }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const registeredPath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        registeredPath
      )
      const worktreePath = await resolveGitActionPath(args, registeredPath, gitOptions)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await unstageFile(worktreePath, filePath, { ...gitOptions, admissionTier: 'interactive' })
    }
  )

  ipcMain.handle(
    'git:discard',
    async (
      _event,
      args: { worktreePath: string; filePath: string; connectionId?: string }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await discardChanges(worktreePath, filePath, { ...gitOptions, admissionTier: 'interactive' })
    }
  )

  ipcMain.handle(
    'git:bulkDiscard',
    async (
      _event,
      args: { worktreePath: string; filePaths: string[]; connectionId?: string }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await bulkDiscardChanges(worktreePath, filePaths, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:bulkStage',
    async (
      _event,
      args: {
        worktreePath: string
        filePaths: string[]
        connectionId?: string
        scope?: unknown
        submodulePath?: string
      }
    ): Promise<void> => {
      const scope = parseGitStageWorktreeScope(args.scope)
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const registeredPath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        registeredPath
      )
      const worktreePath = await resolveGitActionPath(args, registeredPath, gitOptions)
      // The whole-worktree scope reads the parent repo's shared-link settings, not the submodule's.
      if (scope && args.submodulePath !== undefined) {
        throw new Error('Stage All by scope is not available for a submodule')
      }
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      if (scope) {
        const repo = getLocalRepoForRegisteredWorktree(store, args.worktreePath, registeredPath)
        await stageWorktreeChanges(worktreePath, scope, {
          ...gitOptions,
          admissionTier: 'interactive',
          sharedLinkPaths: repo ? getWorktreeSharedLinkPaths(repo) : []
        })
        return
      }
      await bulkStageFiles(worktreePath, filePaths, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:bulkUnstage',
    async (
      _event,
      args: {
        worktreePath: string
        filePaths: string[]
        connectionId?: string
        submodulePath?: string
      }
    ): Promise<void> => {
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const registeredPath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        registeredPath
      )
      const worktreePath = await resolveGitActionPath(args, registeredPath, gitOptions)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      await bulkUnstageFiles(worktreePath, filePaths, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
}
