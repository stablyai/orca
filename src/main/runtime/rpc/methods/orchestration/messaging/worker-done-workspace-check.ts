import type { WorkspaceCheck } from '../../../../../../shared/orchestration/workspace-pr-check'
import { displayPrRepo } from '../../../../../../shared/orchestration/workspace-pr-refs'
import { workspacePrCopy } from '../../../../../../shared/orchestration/workspace-pr-copy'
import { recordWorkspacePrCheck } from '../../../../orchestration/db/messages/record-workspace-pr-check'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { MessageRow } from '../../../../orchestration/db/orchestration-records'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { SendRecipientWarning } from './recipient-routing'

/** Checks an accepted worker_done for pull requests outside its workspace, stores the result with
 *  the report and its task, and returns one receipt warning per outside pull request. */
export function checkWorkerDoneWorkspacePrs(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  msg: MessageRow
  settled: { dispatchId: string; taskId: string }
  from: string
  to: string
}): SendRecipientWarning[] {
  const { runtime, db, msg, settled, from, to } = args
  let check: WorkspaceCheck
  try {
    check = runtime.checkReportedWorkspacePrs(settled.dispatchId, msg.subject, msg.body ?? '')
  } catch {
    check = { version: 1, state: 'skipped', outside: [] }
  }
  recordWorkspacePrCheck(db, msg, settled.taskId, check)
  const primary = db.getWorkerDispatch(settled.dispatchId)?.worktree_id ?? ''
  return check.outside.map((ref) => ({
    code: 'pull_request_outside_workspace',
    recipient: to,
    message: workspacePrCopy.worker(
      displayPrRepo(ref),
      ref.number,
      runtime.getTerminalOrchestrationCliCommand(from),
      primary,
      runtime.getOrchestrationWorkspaceSelectorArgument(from, primary)
    )
  }))
}
