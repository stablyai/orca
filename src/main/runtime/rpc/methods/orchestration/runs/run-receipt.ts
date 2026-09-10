import type { RunRow } from '../../../../orchestration/types'

// Why: home_database and coordinator_pane_key are runtime routing state; no caller reads them.
const INTERNAL_RUN_COLUMNS = ['home_database', 'coordinator_pane_key'] as const

export type RunReceipt = Omit<RunRow, (typeof INTERNAL_RUN_COLUMNS)[number]>

export function exposeRun(run: RunRow): RunReceipt {
  const exposed: Partial<RunRow> = { ...run }
  for (const column of INTERNAL_RUN_COLUMNS) {
    delete exposed[column]
  }
  return exposed as RunReceipt
}
