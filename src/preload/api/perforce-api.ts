import type {
  PerforceDetectResult,
  PerforceEntry,
  PerforceHistoryEntry,
  PerforceOperationResult,
  PerforceStatusResult
} from '../../shared/perforce/perforce-types'

type WorktreeArgs = { worktreePath: string; connectionId?: string }
type Result = Promise<PerforceOperationResult>

export type PerforceApi = {
  detect: (args: WorktreeArgs) => Promise<PerforceDetectResult>
  status: (args: WorktreeArgs) => Promise<PerforceStatusResult>
  history: (args: WorktreeArgs & { limit?: number }) => Promise<PerforceHistoryEntry[]>
  open: (args: WorktreeArgs & { filePaths: string[] }) => Result
  close: (args: WorktreeArgs & { filePaths: string[] }) => Result
  discard: (
    args: WorktreeArgs & { entries: Pick<PerforceEntry, 'path' | 'group' | 'action'>[] }
  ) => Result
  submit: (args: WorktreeArgs & { changelist: 'default' | number; message?: string }) => Result
  sync: (args: WorktreeArgs) => Result
  shelve: (args: WorktreeArgs & { changelist: number }) => Result
  unshelve: (args: WorktreeArgs & { changelist: number }) => Result
  deleteShelf: (args: WorktreeArgs & { changelist: number }) => Result
  createChangelist: (
    args: WorktreeArgs & { description: string; filePaths: string[] }
  ) => Promise<PerforceOperationResult & { changelist?: number }>
  editDescription: (args: WorktreeArgs & { changelist: number; description: string }) => Result
  moveToChangelist: (
    args: WorktreeArgs & { filePaths: string[]; changelist: 'default' | number }
  ) => Result
  deleteChangelist: (args: WorktreeArgs & { changelist: number }) => Result
}
