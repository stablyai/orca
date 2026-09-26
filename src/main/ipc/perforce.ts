import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  PerforceDetectResult,
  PerforceEntry,
  PerforceHistoryEntry,
  PerforceOperationResult,
  PerforceStatusResult
} from '../../shared/perforce-types'
import {
  closeFilesKeepingContent,
  createChangelistWithFiles,
  deleteEmptyChangelist,
  discardFiles,
  moveFilesToChangelist,
  reconcileFiles,
  shelveChangelist,
  submitChangelist,
  submitDefaultChangelist,
  syncLatest
} from '../perforce/perforce-mutations'
import { detectPerforceWorkspace } from '../perforce/perforce-detection'
import { getPerforceHistory, getPerforceStatus } from '../perforce/perforce-status'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'
import { validateGitRelativeFilePath } from './filesystem-path-containment'

type WorktreeArgs = { worktreePath: string }
type FilesArgs = WorktreeArgs & { filePaths: string[] }

async function resolveWorkspace(store: Store, args: WorktreeArgs): Promise<string> {
  return resolveRegisteredWorktreePath(args.worktreePath, store)
}

function validateFiles(cwd: string, filePaths: string[]): string[] {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('At least one file is required')
  }
  return filePaths.map((filePath) => validateGitRelativeFilePath(cwd, filePath))
}

function requireChangelistId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('A pending changelist number is required')
  }
  return value
}

export function registerPerforceHandlers(store: Store): void {
  ipcMain.handle(
    'perforce:detect',
    async (_event, args: WorktreeArgs): Promise<PerforceDetectResult> =>
      detectPerforceWorkspace(await resolveWorkspace(store, args))
  )

  ipcMain.handle(
    'perforce:status',
    async (_event, args: WorktreeArgs): Promise<PerforceStatusResult> =>
      getPerforceStatus(await resolveWorkspace(store, args))
  )

  ipcMain.handle(
    'perforce:history',
    async (_event, args: WorktreeArgs & { limit?: number }): Promise<PerforceHistoryEntry[]> =>
      getPerforceHistory(await resolveWorkspace(store, args), Math.min(args.limit ?? 30, 200))
  )

  ipcMain.handle(
    'perforce:open',
    async (_event, args: FilesArgs): Promise<PerforceOperationResult> => {
      const cwd = await resolveWorkspace(store, args)
      return reconcileFiles(cwd, validateFiles(cwd, args.filePaths))
    }
  )

  ipcMain.handle(
    'perforce:close',
    async (_event, args: FilesArgs): Promise<PerforceOperationResult> => {
      const cwd = await resolveWorkspace(store, args)
      return closeFilesKeepingContent(cwd, validateFiles(cwd, args.filePaths))
    }
  )

  ipcMain.handle(
    'perforce:discard',
    async (
      _event,
      args: WorktreeArgs & { entries: Pick<PerforceEntry, 'path' | 'group' | 'action'>[] }
    ): Promise<PerforceOperationResult> => {
      const cwd = await resolveWorkspace(store, args)
      const paths = validateFiles(
        cwd,
        args.entries.map((entry) => entry.path)
      )
      return discardFiles(
        cwd,
        args.entries.map((entry, index) => ({
          path: paths[index] ?? entry.path,
          group: entry.group,
          action: entry.action
        }))
      )
    }
  )

  ipcMain.handle(
    'perforce:submit',
    async (
      _event,
      args: WorktreeArgs & { changelist: 'default' | number; message?: string }
    ): Promise<PerforceOperationResult> => {
      const cwd = await resolveWorkspace(store, args)
      if (args.changelist === 'default') {
        if (typeof args.message !== 'string' || args.message.trim().length === 0) {
          throw new Error('Submit description is required')
        }
        return submitDefaultChangelist(cwd, args.message.trim())
      }
      return submitChangelist(cwd, requireChangelistId(args.changelist))
    }
  )

  ipcMain.handle(
    'perforce:sync',
    async (_event, args: WorktreeArgs): Promise<PerforceOperationResult> =>
      syncLatest(await resolveWorkspace(store, args))
  )

  ipcMain.handle(
    'perforce:shelve',
    async (_event, args: WorktreeArgs & { changelist: number }): Promise<PerforceOperationResult> =>
      shelveChangelist(await resolveWorkspace(store, args), requireChangelistId(args.changelist))
  )

  ipcMain.handle(
    'perforce:createChangelist',
    async (
      _event,
      args: FilesArgs & { description: string }
    ): Promise<PerforceOperationResult & { changelist?: number }> => {
      const cwd = await resolveWorkspace(store, args)
      if (typeof args.description !== 'string' || args.description.trim().length === 0) {
        throw new Error('Changelist description is required')
      }
      return createChangelistWithFiles(
        cwd,
        args.description,
        args.filePaths.length > 0 ? validateFiles(cwd, args.filePaths) : []
      )
    }
  )

  ipcMain.handle(
    'perforce:moveToChangelist',
    async (
      _event,
      args: FilesArgs & { changelist: 'default' | number }
    ): Promise<PerforceOperationResult> => {
      const cwd = await resolveWorkspace(store, args)
      const target =
        args.changelist === 'default' ? 'default' : requireChangelistId(args.changelist)
      return moveFilesToChangelist(cwd, validateFiles(cwd, args.filePaths), target)
    }
  )

  ipcMain.handle(
    'perforce:deleteChangelist',
    async (_event, args: WorktreeArgs & { changelist: number }): Promise<PerforceOperationResult> =>
      deleteEmptyChangelist(
        await resolveWorkspace(store, args),
        requireChangelistId(args.changelist)
      )
  )
}
