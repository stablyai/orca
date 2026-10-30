import type { OrchestrationDb } from '../../../../orchestration/db'
import type { DispatchContextRow } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { chatAssigneeSessionId, observeChatAssignee } from '../../../../orchestration/chat-assignee'

/** Name the reuse path while the finished worker's terminal or chat is still open. */
export function finishedWorkerFollowUp(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  dispatch: DispatchContextRow
): string {
  const handle = dispatch.assignee_handle
  const chat = chatAssigneeSessionId(handle)
  const open =
    handle !== null &&
    (chat
      ? observeChatAssignee(chat, db).status === 'live'
      : runtime.getOrchestrationDispatchAuthority(handle) !== null)
  if (!open) {
    return 'start a new Dispatch for follow-up work'
  }
  const worktreeId = db.getWorkerDispatch(dispatch.id)?.worktree_id
  return `give its worker follow-up work with \`orca orchestration worker-start --task <task_id> --terminal ${handle}${worktreeId ? ` --worktree id:${worktreeId}` : ''}\``
}
