import type { RunRow } from '../../../../orchestration/db/orchestration-records'
import {
  mailboxAddressOf,
  runCoordinatorKey
} from '../../../../orchestration/addressing/orchestration-caller-identity'

/** Who owns a Run right now, for someone else inspecting it; `actor` is null when the host can't tell. */
export type RunCoordinatorReceipt = {
  run_id: string
  actor: string | null
  consumer_generation: number
  runtime_id: string
}

export function exposeRunCoordinator(run: RunRow, runtimeId: string): RunCoordinatorReceipt {
  return {
    run_id: run.id,
    actor: mailboxAddressOf(runCoordinatorKey(run)),
    consumer_generation: run.consumer_generation,
    runtime_id: runtimeId
  }
}
