/**
 * The stop half of restarting an idle orcad in place: under the host lock, recount with terminal
 * admission closed, and stop only at zero terminals, retiring the idle daemon with it. The caller
 * wakes the slot again over its own transport (an SSH restart, or a WSL host relaunch).
 */
import { randomUUID } from 'node:crypto'
import {
  withOrcadActivationLock,
  type OrcadActivationLockControl
} from '../activation/orcad-activation-lock'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { runFencedStop, type updateTerminalCounts } from '../activation/orcad-fenced-stop'
import type { OrcadTerminalCensus } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import type { OrcadSlotOptions } from '../activation/orcad-recovery-slot'
import { readRemoteOrcadManagedStopTarget } from './orcad-managed-remote-stop'
import { stopIncumbentBehindTerminalBarrier } from './orcad-rollback-terminal-barrier'

export type OrcadIdleRestartStop =
  | { state: 'retired'; version: string }
  /** The surviving daemon still spawns terminals with old attribution. */
  | { state: 'daemon-kept'; version: string; reason: string }
  /** Serving or possibly stopping; do not start another instance. */
  | { state: 'kept'; reason: string; mayBeStopping?: true }
  | { state: 'terminals-running'; liveSessions: number | null }

type RestartCounts = Pick<
  ReturnType<typeof updateTerminalCounts>,
  'recountCensus' | 'releaseIncumbentAdmission'
> & {
  /** Other live work on the fenced recount that keeps the server serving, as the kept reason. */
  refuseOtherWork?: (census: OrcadTerminalCensus) => string | null
}

/** Stops the active orcad only if a fenced recount proves zero terminals. */
export async function stopIdleOrcadForRestart(
  slot: OrcadSlotOptions,
  counts: RestartCounts
): Promise<OrcadIdleRestartStop> {
  return await withOrcadActivationLock(
    slot,
    (lock) => recountThenStop(slot, lock, counts),
    (): OrcadIdleRestartStop => ({
      state: 'kept',
      reason: 'An update, rollback or recovery holds this host; try again when it finishes.'
    })
  )
}

/** Only the host lock holder may close/reopen admission, preserving other runs' fences. */
async function recountThenStop(
  slot: OrcadSlotOptions,
  lock: OrcadActivationLockControl,
  counts: RestartCounts
): Promise<OrcadIdleRestartStop> {
  const fenced = await runFencedStop({
    ...counts,
    now: Date.now,
    refuse: (census): OrcadIdleRestartStop | null => {
      if (census.liveSessions !== 0) {
        return { state: 'terminals-running', liveSessions: census.liveSessions }
      }
      const otherWork = counts.refuseOtherWork?.(census) ?? null
      return otherWork === null ? null : { state: 'kept', reason: otherWork }
    },
    stale: (): OrcadIdleRestartStop => STALE_COUNT,
    stop: (stillFenced) => stopRetiringIdleDaemon(slot, lock, stillFenced),
    // Woken servers start with admission open; only unsent stops need reopening.
    stopMayHaveBeenSent: (outcome) =>
      outcome.state === 'retired' ||
      outcome.state === 'daemon-kept' ||
      (outcome.state === 'kept' && outcome.mayBeStopping === true)
  })
  return 'refused' in fenced ? fenced.refused : fenced.stopped
}

const STALE_COUNT: OrcadIdleRestartStop = {
  state: 'kept',
  reason: 'The terminal count went stale before the stop. Restart again.'
}

async function stopRetiringIdleDaemon(
  slot: OrcadSlotOptions,
  lock: OrcadActivationLockControl,
  stillFenced: () => boolean
): Promise<OrcadIdleRestartStop> {
  // Other clients may change the active slot; reread under the fence.
  const active = (await readOrcadActivationRecord(slot)).active
  if (!active) {
    return { state: 'kept', reason: 'This host has no activated Orca server.' }
  }
  const target = await readRemoteOrcadManagedStopTarget(slot, active)
  if (target.state === 'refused') {
    return { state: 'kept', reason: target.reason }
  }
  // Expired census fences may have admitted terminals; do not stop after expiry.
  if (!stillFenced()) {
    return STALE_COUNT
  }
  const barrier = await stopIncumbentBehindTerminalBarrier(slot, randomUUID(), target.context)
  switch (barrier.state) {
    case 'retired':
      return { state: 'retired', version: active }
    case 'unproven':
      return {
        state: 'daemon-kept',
        version: active,
        reason:
          'This host’s Orca server restarted, but its terminal daemon kept running because a terminal ' +
          'was open at the stop, so terminals may still lack local network access.'
      }
    case 'unsettled':
      // Recovery must retain the fence while orcad may still be stopping.
      lock.retain()
      return { state: 'kept', reason: barrier.reason, mayBeStopping: true }
    case 'withdrawn':
      return { state: 'kept', reason: barrier.reason }
  }
}
