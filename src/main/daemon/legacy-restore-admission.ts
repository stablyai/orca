import type { SpawnRequestFacts } from '../../shared/host-spawn-admission'
import { TERMINAL_SPAWN_REFUSED_MESSAGE } from '../../shared/host-spawn-admission'
import { TERMINAL_HOST_CAP_HINT } from '../../shared/terminal-spawn-error-copy'
import type { LegacyRestoreDetails, LegacyRestoreRecords } from './legacy-restore-records'
import type { TerminalSpawnLease } from './terminal-spawn-gate'

// COMPAT(legacy-restore-intent): added 2026-10-11 (v1.4.214) for clients that predate
// `spawnIntent` (#27452). Remove after 2027-04-11 with the gate's undeclared-caller branches.

function refusalReason(error: unknown): 'pressure' | 'host_cap' | null {
  if (!(error instanceof Error)) {
    return null
  }
  return error.message === TERMINAL_SPAWN_REFUSED_MESSAGE
    ? 'pressure'
    : error.message === TERMINAL_HOST_CAP_HINT
      ? 'host_cap'
      : null
}

/** Save refused legacy restores because old clients clear their own resume records before asking. */
export function admitRecordingLegacyRestore(
  admit: () => TerminalSpawnLease | Promise<TerminalSpawnLease>,
  records: LegacyRestoreRecords | undefined,
  facts: SpawnRequestFacts,
  restore: LegacyRestoreDetails | undefined
): TerminalSpawnLease | Promise<TerminalSpawnLease> {
  if (!records || !restore) {
    return admit()
  }
  const onRefused = (error: unknown): never => {
    const reason = refusalReason(error)
    if (reason && facts.declaredIntent === null) {
      records.record(restore, reason)
    }
    throw error
  }
  const tracked = (lease: TerminalSpawnLease): TerminalSpawnLease => ({
    charge: lease.charge,
    commit: (sessionId, isAlive) => {
      lease.commit(sessionId, isAlive)
      if (isAlive) {
        records.clearStarted(restore)
      }
    },
    abandon: () => lease.abandon()
  })
  let lease: TerminalSpawnLease | Promise<TerminalSpawnLease>
  try {
    lease = admit()
  } catch (error) {
    return onRefused(error)
  }
  return lease instanceof Promise ? lease.then(tracked, onRefused) : tracked(lease)
}
