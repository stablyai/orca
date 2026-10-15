import type {
  PerforceOperationName,
  PerforceOperationParams,
  PerforceOperationResult
} from '../../shared/perforce/perforce-operations'
import type {
  PerforceCopyOperationName,
  PerforceCopyOperationParams,
  PerforceCopyOperationResult
} from '../../shared/perforce/workspace-copy/workspace-copy-operations'
import type { WorkspaceCopyIpcResult } from '../../shared/perforce/workspace-copy/workspace-copy-types'

/** The workspace a request runs in: a local folder, or one on SSH host `connectionId`. */
export type PerforceWorktreeArgs = { worktreePath: string; connectionId?: string }

export type PerforceApi = {
  /** One Perforce workspace operation, run where the workspace lives with Settings > Perforce applied. */
  run: <K extends PerforceOperationName>(
    operation: K,
    args: PerforceWorktreeArgs & PerforceOperationParams[K]
  ) => Promise<PerforceOperationResult<K>>
  /** Whether a folder that is not yet a project is in a Perforce client workspace. */
  detectFolder: (args: {
    folderPath: string
    connectionId?: string
  }) => Promise<PerforceOperationResult<'detect'>>
  generateDescription: (
    args: PerforceWorktreeArgs & {
      changelist: 'default' | 'new' | number
      filePaths: string[]
    }
  ) => Promise<{ success: true; message: string } | { success: false; error: string }>
  /** One copy operation of the Perforce folder project `repoId`; failures come back as `{ ok: false }`. */
  runCopy: <K extends PerforceCopyOperationName>(
    operation: K,
    args: { repoId: string; hostId?: string } & PerforceCopyOperationParams<K>
  ) => Promise<WorkspaceCopyIpcResult<PerforceCopyOperationResult<K>>>
}
