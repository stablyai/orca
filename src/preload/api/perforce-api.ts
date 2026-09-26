import type {
  PerforceDetectResult,
  PerforceEntry,
  PerforceHistoryEntry,
  PerforceOperationResult,
  PerforceStatusResult
} from '../../shared/perforce-types'

type WorktreeArgs = { worktreePath: string }

export type PerforceApi = {
  detect: (args: WorktreeArgs) => Promise<PerforceDetectResult>
  status: (args: WorktreeArgs) => Promise<PerforceStatusResult>
  history: (args: WorktreeArgs & { limit?: number }) => Promise<PerforceHistoryEntry[]>
  open: (args: WorktreeArgs & { filePaths: string[] }) => Promise<PerforceOperationResult>
  close: (args: WorktreeArgs & { filePaths: string[] }) => Promise<PerforceOperationResult>
  discard: (
    args: WorktreeArgs & { entries: Pick<PerforceEntry, 'path' | 'group' | 'action'>[] }
  ) => Promise<PerforceOperationResult>
  submit: (
    args: WorktreeArgs & { changelist: 'default' | number; message?: string }
  ) => Promise<PerforceOperationResult>
  sync: (args: WorktreeArgs) => Promise<PerforceOperationResult>
  shelve: (args: WorktreeArgs & { changelist: number }) => Promise<PerforceOperationResult>
  createChangelist: (
    args: WorktreeArgs & { description: string; filePaths: string[] }
  ) => Promise<PerforceOperationResult & { changelist?: number }>
  moveToChangelist: (
    args: WorktreeArgs & { filePaths: string[]; changelist: 'default' | number }
  ) => Promise<PerforceOperationResult>
  deleteChangelist: (
    args: WorktreeArgs & { changelist: number }
  ) => Promise<PerforceOperationResult>
}
