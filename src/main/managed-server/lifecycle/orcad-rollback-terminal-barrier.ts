// Pre-stop census can go stale; only fenced idle-daemon retirement proves snapshot replacement safe.
import {
  readRemoteOrcadManagedStopTarget,
  type OrcadManagedStopTarget
} from './orcad-managed-remote-stop'
import { settleOrcadDecommissionStop } from './orcad-decommission-stop'
import type { OrcadSlotOptions } from '../../ssh/orcad-recovery-slot'
import type { OrcadManagedStopContext } from '../../../shared/orcad-stop-request'

type OrcadRollbackBarrier =
  | { state: 'retired' }
  | { state: 'withdrawn'; reason: string }
  /** Stop underway or unconfirmed; retain the fence. */
  | { state: 'unsettled'; reason: string }
  /** Exit without proof of idle terminals requires restarting the incumbent. */
  | { state: 'unproven'; reason: string }

export async function readOrcadRollbackBarrierTarget(
  options: OrcadSlotOptions,
  version: string
): Promise<OrcadManagedStopTarget> {
  const target = await readRemoteOrcadManagedStopTarget(options, version)
  return target.state === 'ready'
    ? target
    : {
        ...target,
        code: 'orcad_rollback_terminal_barrier_unavailable',
        reason:
          `${target.reason} A rollback needs orcad to prove no terminal runs at its stop; ` +
          'nothing was changed.'
      }
}

export async function stopIncumbentBehindTerminalBarrier(
  options: OrcadSlotOptions,
  transactionId: string,
  context: OrcadManagedStopContext
): Promise<OrcadRollbackBarrier> {
  const settlement = await settleOrcadDecommissionStop(options, {
    schemaVersion: 1,
    transactionId,
    ...context,
    retireIdleDaemon: true
  })
  if (settlement.state === 'withdrawn' || settlement.state === 'unsettled') {
    return { state: settlement.state, reason: settlement.reason }
  }
  if (settlement.retirement === 'retired') {
    return { state: 'retired' }
  }
  return {
    state: 'unproven',
    reason:
      `orcad ${context.version} stopped, but its terminal daemon reported ` +
      `${settlement.retirement} work at the stop, so the older snapshot was not restored.`
  }
}

type OrcadRollbackBarrierRefusal = {
  outcome: 'refused' | 'failed'
  code: string
  reason: string
  retainFence: boolean
  restartIncumbent: boolean
}

/** Only retired daemons permit replacing current state with an older snapshot. */
export function rollbackBarrierRefusal(
  barrier: OrcadRollbackBarrier
): OrcadRollbackBarrierRefusal | null {
  switch (barrier.state) {
    case 'retired':
      return null
    case 'withdrawn':
      return {
        outcome: 'failed',
        code: 'orcad_rollback_stop_withdrawn',
        reason: barrier.reason,
        retainFence: false,
        restartIncumbent: false
      }
    case 'unsettled':
      return {
        outcome: 'failed',
        code: 'orcad_rollback_stop_incomplete',
        reason: `${barrier.reason} Nothing was restored.`,
        retainFence: true,
        restartIncumbent: false
      }
    case 'unproven':
      return {
        outcome: 'refused',
        code: 'orcad_rollback_terminals_at_stop',
        reason: barrier.reason,
        retainFence: false,
        restartIncumbent: true
      }
  }
}
