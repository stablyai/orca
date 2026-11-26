// What Orca continued on its own, and which cuts a person dismissed, kept beside the offers and
// written under the capsule's lock. A ledger, not journal counts: a continuation's send looks like
// a person's, and a run can die before its note.

import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import { restartActivityWaitsOnPerson } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-activity'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import { writeRecoveryFileDurable } from './agent-session-recovery-capsule-file'
import type { RecoveryEntry } from './agent-session-recovery-capsule-entries'

const LEDGER_FILE = 'agent-session-recovery-automatic.json'
const MAX_LEDGER_BYTES = 1024 * 1024
export const AUTOMATIC_CONTINUATION_LIMIT = 3
export const AUTOMATIC_CONTINUATION_WINDOW_MS = 5 * 60_000
/** Long enough to remember a cut across a crash loop; a day-old cut is no longer automatic anyway. */
const TAKEN_RETENTION_MS = 24 * 60 * 60_000
const DISMISSED_LIMIT = 500
/** Bounds the file below its read limit; an unreadable ledger would stop every automatic continuation. */
const PASSED_LIMIT = 1000

const ledgerSchema = z.object({
  taken: z.record(z.string(), z.array(z.object({ at: z.number(), work: z.string() }))),
  passed: z.array(z.string()),
  dismissed: z.array(z.string()).default([])
})

export type AutomaticRestartLedger = z.infer<typeof ledgerSchema>

const EMPTY: AutomaticRestartLedger = { taken: {}, passed: [], dismissed: [] }

function offerKey(marker: AgentSessionResumeMarker): string {
  return `${marker.sessionId}:${marker.teardownId}:${marker.recordedAt}`
}

function cutOf(marker: AgentSessionResumeMarker): string {
  return `${marker.work.kind}:${marker.work.id}`
}

function ledgerPath(capsulePath: string): string {
  return join(dirname(capsulePath), LEDGER_FILE)
}

/** A missing ledger is empty; null when it cannot be read, so nothing is taken automatically and
 *  nothing replaces it. */
export async function readAutomaticReservationLedger(
  capsulePath: string
): Promise<AutomaticRestartLedger | null> {
  return readLedger(capsulePath)
}

async function readLedger(capsulePath: string): Promise<AutomaticRestartLedger | null> {
  try {
    const { buffer } = await readNodeFileWithinLimit(ledgerPath(capsulePath), MAX_LEDGER_BYTES)
    return ledgerSchema.parse(JSON.parse(buffer.toString('utf8')))
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? EMPTY : null
  }
}

function takenEntries(taken: AutomaticRestartLedger['taken']) {
  return Object.entries(taken).flatMap(([sessionId, list]) =>
    list.map((entry) => ({ sessionId, entry }))
  )
}

/** Drops the oldest tenth; with `outsideWindowOnly`, never an entry that still counts toward the rate limit. */
function dropOldestTaken(
  taken: AutomaticRestartLedger['taken'],
  outsideWindowOnly: boolean
): AutomaticRestartLedger['taken'] {
  const entries = takenEntries(taken).sort((a, b) => a.entry.at - b.entry.at)
  const newest = entries.at(-1)?.entry.at ?? 0
  const droppable = outsideWindowOnly
    ? entries.filter(({ entry }) => newest - entry.at > AUTOMATIC_CONTINUATION_WINDOW_MS)
    : entries
  const dropped = new Set(droppable.slice(0, Math.ceil(droppable.length / 10)))
  const kept: AutomaticRestartLedger['taken'] = {}
  for (const item of entries) {
    if (!dropped.has(item)) {
      kept[item.sessionId] = [...(kept[item.sessionId] ?? []), item.entry]
    }
  }
  return kept
}

/** Offer ids can be 512 characters; shed the least harmful records first until the file fits well inside its read limit. Entries still inside the rate-limit window go last, so a crash loop stays bounded. */
function fitLedgerToReadLimit(ledger: AutomaticRestartLedger): AutomaticRestartLedger {
  const fitted = { ...ledger }
  const exceeds = (limit: number): boolean => Buffer.byteLength(JSON.stringify(fitted)) > limit
  const tooLarge = (): boolean => exceeds(MAX_LEDGER_BYTES / 2)
  const oldTaken = (): boolean => {
    const entries = takenEntries(fitted.taken)
    const newest = Math.max(0, ...entries.map((item) => item.entry.at))
    return entries.some(({ entry }) => newest - entry.at > AUTOMATIC_CONTINUATION_WINDOW_MS)
  }
  while (tooLarge()) {
    if (oldTaken()) {
      fitted.taken = dropOldestTaken(fitted.taken, true)
    } else if (fitted.dismissed.length > 0) {
      fitted.dismissed = fitted.dismissed.slice(Math.ceil(fitted.dismissed.length / 10))
    } else if (fitted.passed.length > 0) {
      fitted.passed = fitted.passed.slice(Math.ceil(fitted.passed.length / 10))
    } else if (exceeds(MAX_LEDGER_BYTES) && Object.keys(fitted.taken).length > 0) {
      fitted.taken = dropOldestTaken(fitted.taken, false)
    } else {
      break
    }
  }
  return fitted
}

export function writeAutomaticRestartLedger(
  capsulePath: string,
  ledger: AutomaticRestartLedger
): Promise<void> {
  return writeRecoveryFileDurable(
    ledgerPath(capsulePath),
    JSON.stringify(fitLedgerToReadLimit(ledger))
  )
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

/** A crash cut is read again while its chat stays held, giving the same offer; a dismissed one stays gone. */
export function dismissedOffer(
  ledger: AutomaticRestartLedger,
  marker: AgentSessionResumeMarker
): boolean {
  return ledger.dismissed.includes(offerKey(marker))
}

/** Call under the capsule's lock. An unreadable ledger is left as it is: replacing it would forget
 *  what Orca already continued on its own. */
export async function recordDismissedOffers(
  capsulePath: string,
  markers: readonly AgentSessionResumeMarker[]
): Promise<void> {
  const ledger = await readAutomaticReservationLedger(capsulePath)
  if (!ledger) {
    return
  }
  const keys = markers.map(offerKey)
  const kept = ledger.dismissed.filter((key) => !keys.includes(key))
  await writeAutomaticRestartLedger(capsulePath, {
    ...ledger,
    dismissed: [...kept, ...keys].slice(-DISMISSED_LIMIT)
  })
}

/** Offers still waiting when a launch ends were this launch's to continue; later launches leave them
 *  to a person. A quit during the turn records offers after `recordedBy`; those are the next
 *  launch's. One reserved meanwhile stays passed over, should its reservation be undone. */
export function passOverAutomaticOffers(
  ledger: AutomaticRestartLedger,
  entries: readonly RecoveryEntry[],
  recordedBy: number
): AutomaticRestartLedger {
  const waiting = entries.flatMap((entry) =>
    entry.state === 'pending' && entry.marker.recordedAt <= recordedBy ? [entry.marker] : []
  )
  const reserved = entries.flatMap((entry) =>
    entry.state === 'in-progress'
      ? [entry.marker, ...(entry.replacement ? [entry.replacement] : [])]
      : []
  )
  const stillPassed = reserved.map(offerKey).filter((key) => ledger.passed.includes(key))
  const passed = [...new Set([...stillPassed, ...waiting.map(offerKey)])].slice(-PASSED_LIMIT)
  return { ...ledger, passed }
}
