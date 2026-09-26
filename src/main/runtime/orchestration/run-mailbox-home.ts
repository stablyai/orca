import { z } from 'zod'
import type { OrchestrationDb } from './db'
import type { RunRow } from './types'
import { OrchestrationError } from './orchestration-error'

const HOME_PEERS = z.array(z.object({ home_peer_fingerprint: z.string() }))

export function readRunMailboxHome(db: OrchestrationDb, run: RunRow, runtimeId: string) {
  const homePeerFingerprints =
    run.home_database === 'remote'
      ? HOME_PEERS.parse(
          db.db
            .prepare(`SELECT DISTINCT home_peer_fingerprint FROM remote_dispatch_attachments
      WHERE home_run_id = ? ORDER BY home_peer_fingerprint`)
            .all(run.id)
        ).map((row) => row.home_peer_fingerprint)
      : []
  const home =
    run.home_database === 'remote'
      ? 'remote'
      : run.home_database === 'this_database'
        ? 'local'
        : 'unresolved'
  return {
    runId: run.id,
    runtimeId,
    home,
    homePeerFingerprints,
    coordinatorHandle: run.coordinator_handle,
    consumerGeneration: run.consumer_generation
  }
}

export function assertLocalRunMailbox(db: OrchestrationDb, runId: string, runtimeId: string) {
  const run = db.getRun(runId)
  if (!run || run.legacy === 1) {
    throw new OrchestrationError('run_not_found', `Run ${runId} was not found.`, {
      effectsApplied: false
    })
  }
  const routing = readRunMailboxHome(db, run, runtimeId)
  if (routing.home === 'remote') {
    throw new OrchestrationError(
      'run_destination_unsupported',
      `Run ${runId} belongs to a remote home. Send from its capability-bound Dispatch without --to/--run, or send on the Run-home runtime. No message was queued.`,
      { effectsApplied: false, routing }
    )
  }
  // A past local binding survives coordinator absence; a never-bound stub does not prove ownership.
  const adoptedOwner = run.consumer_generation === 0 ? db.getLegacyAdoptedRunMailboxOwner() : null
  if (
    routing.home !== 'local' ||
    (run.consumer_generation === 0 && adoptedOwner?.runId !== run.id)
  ) {
    throw new OrchestrationError(
      'run_destination_unresolved',
      `Run ${runId} has no proven local mailbox owner. Inspect run-show on the intended home runtime; no message was queued.`,
      { effectsApplied: false, routing }
    )
  }
  return {
    state: 'queued' as const,
    destination: 'run_home' as const,
    custody: 'run_home_mailbox' as const,
    ...routing
  }
}
