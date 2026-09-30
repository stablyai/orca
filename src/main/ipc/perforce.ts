import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  PerforceDetectResult,
  PerforceEntry,
  PerforceHistoryEntry,
  PerforceOperationResult,
  PerforceStatusResult
} from '../../shared/perforce/perforce-types'
import {
  requireChangelistId,
  requireChangelistTarget,
  requireDepotPaths,
  requireDescription,
  requireDiscardEntries,
  requireRelativePaths
} from '../../shared/perforce/perforce-arguments'
import type { PerforceBackend } from '../../shared/perforce/perforce-backend'
import { normalizePerforceSettings } from '../../shared/perforce/perforce-settings'
import { resolvePerforceBackend, setPerforceSettingsSource } from '../perforce/perforce-ssh-backend'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { registerPerforceDescriptionGeneration } from './perforce-description-generation'
import { resolveRegisteredWorktreePath } from './registered-worktree-roots-cache'

type WorktreeArgs = { worktreePath: string; connectionId?: string }
type FilesArgs = WorktreeArgs & { filePaths: string[] }
type ChangelistArgs = WorktreeArgs & { changelist: number }
type Result = PerforceOperationResult

/** Resolves where the workspace lives and hands its operations to the matching backend. */
async function withWorkspace<T>(
  store: Store,
  args: WorktreeArgs,
  run: (backend: PerforceBackend, cwd: string) => Promise<T>
): Promise<T> {
  // Why: SSH paths belong to the remote host; only local paths are checked against registered roots.
  const cwd = args.connectionId
    ? args.worktreePath
    : await resolveRegisteredWorktreePath(args.worktreePath, store)
  return run(resolvePerforceBackend(args.connectionId), cwd)
}

export function registerPerforceHandlers(
  store: Store,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  setPerforceSettingsSource(() => normalizePerforceSettings(store.getSettings().perforce))
  registerPerforceDescriptionGeneration(store, commitMessageAgentEnv)

  const handle = <A extends WorktreeArgs, T>(
    channel: string,
    run: (backend: PerforceBackend, cwd: string, args: A) => Promise<T>
  ): void => {
    ipcMain.handle(`perforce:${channel}`, (_event, args: A) =>
      withWorkspace(store, args, (backend, cwd) => run(backend, cwd, args))
    )
  }

  handle<WorktreeArgs, PerforceDetectResult>('detect', (b, cwd) => b.detect(cwd))
  handle<WorktreeArgs, Awaited<ReturnType<PerforceBackend['info']>>>('info', (b, cwd) =>
    b.info(cwd)
  )
  handle<WorktreeArgs, PerforceStatusResult>('status', (b, cwd) => b.status(cwd))
  handle<WorktreeArgs & { limit?: number }, PerforceHistoryEntry[]>('history', (b, cwd, a) =>
    b.history(cwd, Math.min(a.limit ?? 30, 200))
  )
  handle<FilesArgs, Result>('open', (b, cwd, a) => b.open(cwd, requireRelativePaths(a.filePaths)))
  handle<FilesArgs, Result>('close', (b, cwd, a) => b.close(cwd, requireRelativePaths(a.filePaths)))
  handle<WorktreeArgs & { entries: Pick<PerforceEntry, 'path' | 'group' | 'action'>[] }, Result>(
    'discard',
    (b, cwd, a) => b.discard(cwd, requireDiscardEntries(a.entries))
  )
  handle<WorktreeArgs & { changelist: 'default' | number; message?: string }, Result>(
    'submit',
    (b, cwd, a) => {
      const target = requireChangelistTarget(a.changelist)
      return b.submit(
        cwd,
        target,
        target === 'default' ? requireDescription(a.message, 'Submit description') : undefined
      )
    }
  )
  handle<WorktreeArgs, Result>('sync', (b, cwd) => b.sync(cwd))
  handle<ChangelistArgs, Result>('shelve', (b, cwd, a) =>
    b.shelve(cwd, requireChangelistId(a.changelist))
  )
  handle<ChangelistArgs, Result>('unshelve', (b, cwd, a) =>
    b.unshelve(cwd, requireChangelistId(a.changelist))
  )
  handle<WorktreeArgs & { sourceChangelist: number; changelist: 'default' | number }, Result>(
    'unshelveFrom',
    (b, cwd, a) =>
      b.unshelveFrom(
        cwd,
        requireChangelistId(a.sourceChangelist),
        requireChangelistTarget(a.changelist)
      )
  )
  handle<ChangelistArgs & { filePaths: string[] }, Result>('shelveAndRevertFiles', (b, cwd, a) =>
    b.shelveAndRevertFiles(
      cwd,
      requireChangelistId(a.changelist),
      requireRelativePaths(a.filePaths)
    )
  )
  handle<ChangelistArgs & { depotPaths: string[] }, Result>('unshelveFiles', (b, cwd, a) =>
    b.unshelveFiles(cwd, requireChangelistId(a.changelist), requireDepotPaths(a.depotPaths))
  )
  handle<ChangelistArgs, Result>('deleteChangelistWithFiles', (b, cwd, a) =>
    b.deleteChangelistWithFiles(cwd, requireChangelistId(a.changelist))
  )
  handle<ChangelistArgs, Result>('deleteShelf', (b, cwd, a) =>
    b.deleteShelf(cwd, requireChangelistId(a.changelist))
  )
  handle<FilesArgs & { description: string }, Result & { changelist?: number }>(
    'createChangelist',
    (b, cwd, a) =>
      b.createChangelist(
        cwd,
        requireDescription(a.description, 'Changelist description'),
        a.filePaths.length > 0 ? requireRelativePaths(a.filePaths) : []
      )
  )
  handle<ChangelistArgs & { description: string }, Result>('editDescription', (b, cwd, a) =>
    b.editDescription(
      cwd,
      requireChangelistId(a.changelist),
      requireDescription(a.description, 'Changelist description')
    )
  )
  handle<FilesArgs & { changelist: 'default' | number }, Result>('moveToChangelist', (b, cwd, a) =>
    b.moveToChangelist(
      cwd,
      requireRelativePaths(a.filePaths),
      requireChangelistTarget(a.changelist)
    )
  )
  handle<ChangelistArgs, Result>('deleteChangelist', (b, cwd, a) =>
    b.deleteChangelist(cwd, requireChangelistId(a.changelist))
  )
}
