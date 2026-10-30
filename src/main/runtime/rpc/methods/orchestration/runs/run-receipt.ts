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
