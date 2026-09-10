import type { MaestroTerminalLease } from '../../../../../shared/maestro-terminal-lease'
import type { MaestroRunProgressV2 } from '../../../../../shared/maestro-run-progress'
import type { DispatchContextRow, TaskRow } from '../../types'

export type TaskProgressOutcome = keyof MaestroRunProgressV2['execution']['counts']

export function projectOperationalTaskOutcome(
  task: TaskRow,
  lease: MaestroTerminalLease | undefined
): NonNullable<TaskRow['operational_outcome']> | undefined {
  if (task.operational_outcome) {
    return task.operational_outcome
  }
  if (lease?.lifecycleState === 'outcome_unknown') {
    return 'unverifiable'
  }
  if (task.status === 'completed') {
    return 'successful'
  }
  return task.status === 'failed' ? 'failed' : undefined
}

export function projectTaskProgressOutcome(
  task: TaskRow,
  dispatch: DispatchContextRow | undefined,
  lease: MaestroTerminalLease | undefined
): TaskProgressOutcome {
  if (task.status === 'completed') {
    return 'succeeded'
  }
  if (task.status === 'failed') {
    return dispatch?.termination_reason === 'operator_close' ? 'cancelled' : 'failed'
  }
  if (task.status === 'blocked') {
    return 'blocked'
  }
  if (lease?.lifecycleState === 'input_required') {
    return 'input_required'
  }
  return task.status === 'dispatched' ? 'running' : 'pending'
}
