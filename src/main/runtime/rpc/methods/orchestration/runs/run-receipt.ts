import type { RunRow } from '../../../../orchestration/db/orchestration-records'
import type { MessageType } from '../../../../../../shared/orchestration/orchestration-message-types'
import { parseRunNotifyTypes } from '../../../../orchestration/db/runs/run-notify-types'

// Hide routing-only home_database/coordinator_pane_key and the unread coordinator session id; adding it later changes the wire contract.
const INTERNAL_RUN_COLUMNS = [
  'home_database',
  'coordinator_pane_key',
  'coordinator_orca_session_id',
  'coordinator_orca_session_id_generation',
  'notify_types'
] as const

export type RunReceipt = Omit<RunRow, (typeof INTERNAL_RUN_COLUMNS)[number]> & {
  /** Absent means every message type may wake this Run's coordinator. */
  notifyTypes?: MessageType[]
}

export function exposeRun(run: RunRow): RunReceipt {
  const exposed: Partial<RunRow> = { ...run }
  for (const column of INTERNAL_RUN_COLUMNS) {
    delete exposed[column]
  }
  const notifyTypes = parseRunNotifyTypes(run.notify_types)
  const exposedWithNotify = notifyTypes ? { ...exposed, notifyTypes } : exposed
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: INTERNAL_RUN_COLUMNS is the only difference between RunRow and RunReceipt.
  const receipt = exposedWithNotify as RunReceipt
  return receipt
}
