// What Orca continued on its own, kept beside the offers and written under the capsule's lock. A
// ledger, not journal counts: a continuation's send looks like a person's, and a run can die
// before its note.

import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import { restartActivityWaitsOnPerson } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-activity'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import { writeRecoveryFileDurable } from './agent-session-recovery-capsule-file'

const LEDGER_FILE = 'agent-session-recovery-automatic.json'
const MAX_LEDGER_BYTES = 256 * 1024
export const AUTOMATIC_CONTINUATION_LIMIT = 3
export const AUTOMATIC_CONTINUATION_WINDOW_MS = 5 * 60_000
/** Long enough to remember a cut across a crash loop; a day-old cut is no longer automatic anyway. */
const TAKEN_RETENTION_MS = 24 * 60 * 60_000

const ledgerSchema = z.object({
  taken: z.record(z.string(), z.array(z.object({ at: z.number(), work: z.string() }))),
  passed: z.array(z.string())
})

export type AutomaticRestartLedger = z.infer<typeof ledgerSchema>

const EMPTY: AutomaticRestartLedger = { taken: {}, passed: [] }

function offerKey(marker: AgentSessionResumeMarker): string {
  return `${marker.sessionId}:${marker.teardownId}:${marker.recordedAt}`
}

function cutOf(marker: AgentSessionResumeMarker): string {
  return `${marker.work.kind}:${marker.work.id}`
}

function ledgerPath(capsulePath: string): string {
  return join(dirname(capsulePath), LEDGER_FILE)
}

/** A missing or unreadable ledger is empty: the worst case is one continuation too many. */
export async function readAutomaticRestartLedger(
  capsulePath: string
): Promise<AutomaticRestartLedger> {
  try {
    const { buffer } = await readNodeFileWithinLimit(ledgerPath(capsulePath), MAX_LEDGER_BYTES)
    return ledgerSchema.parse(JSON.parse(buffer.toString('utf8')))
  } catch {
    return EMPTY
  }
}

export function writeAutomaticRestartLedger(
  capsulePath: string,
  ledger: AutomaticRestartLedger
): Promise<void> {
  return writeRecoveryFileDurable(ledgerPath(capsulePath), JSON.stringify(ledger))
}

/** Orca continues on its own only a cut from the run that just ended, whose agent was proven to
 *  have exited, that no person is being asked about, that it has not continued before, and while it
 *  took fewer than three in five minutes. */
export function automaticallyContinuable(
  ledger: AutomaticRestartLedger,
  marker: AgentSessionResumeMarker,
  now: number
): boolean {
  const taken = ledger.taken[marker.sessionId] ?? []
  return (
    !ledger.passed.includes(offerKey(marker)) &&
    marker.exitUnproven !== true &&
    !restartActivityWaitsOnPerson(marker.activity) &&
    !taken.some((entry) => entry.work === cutOf(marker)) &&
    taken.filter((entry) => now - entry.at <= AUTOMATIC_CONTINUATION_WINDOW_MS).length <
      AUTOMATIC_CONTINUATION_LIMIT
  )
}

export function recordAutomaticContinuations(
  ledger: AutomaticRestartLedger,
  markers: readonly AgentSessionResumeMarker[],
  now: number
): AutomaticRestartLedger {
  const taken: AutomaticRestartLedger['taken'] = {}
  for (const [sessionId, entries] of Object.entries(ledger.taken)) {
    const kept = entries.filter((entry) => now - entry.at <= TAKEN_RETENTION_MS)
    if (kept.length > 0) {
      taken[sessionId] = kept
    }
  }
  for (const marker of markers) {
    taken[marker.sessionId] = [...(taken[marker.sessionId] ?? []), { at: now, work: cutOf(marker) }]
  }
  return { ...ledger, taken }
}

/** Offers still waiting when a launch ends were this launch's to continue; later launches leave them to a person. */
export function passOverAutomaticOffers(
  ledger: AutomaticRestartLedger,
  waiting: readonly AgentSessionResumeMarker[]
): AutomaticRestartLedger {
  return { ...ledger, passed: waiting.map(offerKey) }
}
