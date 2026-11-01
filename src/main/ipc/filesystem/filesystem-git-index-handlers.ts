import { ipcMain } from 'electron'
import {
  resolveConflict,
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
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { parseGitStageWorktreeScope } from '../../../shared/git-stage-worktree-scope'
import { requireReachableGitRoute } from '../../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'
import {
  CONFLICT_RESOLUTIONS,
  type ConflictResolution
} from '../../../shared/source-control-entry-actions'

export function registerFilesystemGitIndexHandlers(context: FilesystemHandlerContext): void {
  const { store } = context
  ipcMain.handle(
    'git:stage',
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
      await stageFile(worktreePath, filePath, { ...gitOptions, admissionTier: 'interactive' })
    }
  )

  ipcMain.handle(
    'git:resolveConflict',
    async (
      _event,
      args: {
        worktreePath: string
        filePath: string
        resolution: ConflictResolution
        connectionId?: string
      }
    ): Promise<void> => {
      if (!CONFLICT_RESOLUTIONS.includes(args.resolution)) {
        throw new Error('Unknown conflict resolution')
      }
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await resolveConflict(worktreePath, filePath, args.resolution, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )

  ipcMain.handle(
    'git:unstage',
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
      args: { worktreePath: string; filePaths: string[]; connectionId?: string; scope?: unknown }
    ): Promise<void> => {
      const scope = parseGitStageWorktreeScope(args.scope)
      requireReachableGitRoute(getConnectionExecutionHostId(args.connectionId))
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      if (scope) {
        const repo = getLocalRepoForRegisteredWorktree(store, args.worktreePath, worktreePath)
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
      await bulkUnstageFiles(worktreePath, filePaths, {
        ...gitOptions,
        admissionTier: 'interactive'
      })
    }
  )
}
