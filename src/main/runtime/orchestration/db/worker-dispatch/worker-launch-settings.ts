import type { OrchestrationDb } from '../orchestration-db'
import {
  workerStartOptionsLaunch,
  type WorkerLaunchEffectiveSettings
} from '../../workers/launch/worker-launch-observation'

/** The launch choices recorded for the worker's newest Dispatch; an older launch on a reused handle must not answer for it. */
export function findWorkerLaunchSettingsForAssignee(
  db: OrchestrationDb,
  handle: string
): WorkerLaunchEffectiveSettings | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection selects exactly start_options.
  const rows = db.db
    .prepare(
      `SELECT w.start_options FROM worker_dispatches w
         JOIN dispatch_contexts d ON d.id = w.dispatch_id
        WHERE d.assignee_handle = ?
        ORDER BY w.rowid DESC LIMIT 1`
    )
    .all(handle) as { start_options: string }[]
  // A launch whose observation has not merged yet omits the line instead of inheriting the previous process's choices.
  return rows[0] ? workerStartOptionsLaunch(rows[0].start_options) : null
}
