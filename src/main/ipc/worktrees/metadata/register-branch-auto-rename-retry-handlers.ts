import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type {
  BranchAutoRenameDismissResult,
  BranchAutoRenameRetryAvailability,
  BranchAutoRenameRetryResult
} from '../../../../shared/worktree/branch-auto-rename-attempt'
import {
  firstWorkDismissDeps,
  firstWorkRenameDeps,
  firstWorkRetryDeps
} from '../../../agent-hooks/first-work/first-work-rename-runtime'
import { dismissFirstWorkRename } from '../../../agent-hooks/first-work/first-work-rename-dismiss'
import {
  getFirstWorkRetryAvailability,
  retryFirstWorkRename
} from '../../../agent-hooks/first-work/first-work-rename-retry'
import {
  installFirstWorkAttemptNotifier,
  waitForFirstWorkAttempt
} from '../../../agent-hooks/first-work/first-work-rename-attempts'
import { sendToTrustedUIRenderer } from '../../ui'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

type RetryArgs = { worktreeId: string; executionHostId?: string }

function localWorktreeId(args: RetryArgs | undefined): string | null {
  if (typeof args?.worktreeId !== 'string' || args.worktreeId.length === 0) {
    return null
  }
  // A same-id twin on a paired host is never renamed from here.
  const hostId =
    args.executionHostId === undefined
      ? LOCAL_EXECUTION_HOST_ID
      : parseExecutionHostId(args.executionHostId)?.id
  return hostId === LOCAL_EXECUTION_HOST_ID ? args.worktreeId : null
}

export function registerBranchAutoRenameRetryHandlers(
  context: WorktreeIpcContext,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  const { store, runtime } = context
  installFirstWorkAttemptNotifier((event) =>
    sendToTrustedUIRenderer('worktrees:branchAutoRenameAttempt', event)
  )
  ipc.handle(
    'worktrees:getBranchAutoRenameRetryAvailability',
    (_event, args: RetryArgs): Promise<BranchAutoRenameRetryAvailability> => {
      const worktreeId = localWorktreeId(args)
      return worktreeId
        ? getFirstWorkRetryAvailability(
            worktreeId,
            LOCAL_EXECUTION_HOST_ID,
            firstWorkRenameDeps(store, runtime)
          )
        : Promise.resolve({ available: false, runningAttemptId: null })
    }
  )
  ipc.handle(
    'worktrees:retryBranchAutoRename',
    (_event, args: RetryArgs): Promise<BranchAutoRenameRetryResult> => {
      const worktreeId = localWorktreeId(args)
      return worktreeId
        ? retryFirstWorkRename(worktreeId, firstWorkRetryDeps(store, runtime))
        : Promise.resolve({
            attemptId: null,
            outcome: { kind: 'ineligible', reason: 'unavailable' },
            finishedAt: Date.now()
          })
    }
  )
  ipc.handle(
    'worktrees:waitBranchAutoRenameAttempt',
    async (
      _event,
      args: RetryArgs & { attemptId?: number }
    ): Promise<BranchAutoRenameRetryResult | null> => {
      const worktreeId = localWorktreeId(args)
      return worktreeId && typeof args.attemptId === 'number'
        ? ((await waitForFirstWorkAttempt(worktreeId, args.attemptId)) ?? null)
        : null
    }
  )
  ipc.handle(
    'worktrees:dismissBranchAutoRename',
    (_event, args: RetryArgs): BranchAutoRenameDismissResult => {
      const worktreeId = localWorktreeId(args)
      return worktreeId
        ? dismissFirstWorkRename(worktreeId, firstWorkDismissDeps(store, runtime))
        : { dismissed: false }
    }
  )
}
