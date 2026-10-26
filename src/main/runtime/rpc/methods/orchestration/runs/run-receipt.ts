import type { RunAuthorityRow } from '../../../../orchestration/db/runs/run-authority-store'
import type { RunRow } from '../../../../orchestration/types'

// Hide routing-only home_database/coordinator_pane_key and the unread coordinator session id; adding it later changes the wire contract.
const INTERNAL_RUN_COLUMNS = [
  'home_database',
  'coordinator_pane_key',
  'coordinator_orca_session_id',
  'coordinator_orca_session_id_generation'
] as const

export type RunReceipt = Omit<RunRow, (typeof INTERNAL_RUN_COLUMNS)[number]>

export function exposeRun(run: RunRow): RunReceipt {
  const exposed: Partial<RunRow> = { ...run }
  for (const column of INTERNAL_RUN_COLUMNS) {
    delete exposed[column]
  }
  return exposed as RunReceipt
}

export function exposeRunOwnership(authority: RunAuthorityRow | undefined) {
  return authority
    ? {
        creatingDispatchId: authority.creating_dispatch_id,
        creatingTaskId: authority.creating_task_id,
        parentRunId: authority.parent_run_id,
        creatingHomePeer: authority.creating_home_peer,
        ownerTaskId: authority.owner_task_id,
        ownerHomePeer: authority.owner_home_peer
      }
    : undefined
}
