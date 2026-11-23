import {
  readJournalLegacySourceReceipt,
  sameJournalLegacySource
} from './database/journal-legacy-source-receipt'
import { journalDomainDatabasePath } from './database/journal-host-database'
import { legacyDestinationMain, legacyFilePresent } from './journal-legacy-retirement-files'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import {
  compareAppVersions,
  isValidAppVersion
} from '../../../shared/app-lifecycle/identity/app-version'
import { LEGACY_PROOF_LAYOUT, type LegacySourceHeld } from './journal-legacy-retirement-state'
import type { JournalLegacyProof, LegacyProofObservation } from './journal-legacy-proof'
import type { LegacyJournalRetirementOutcome } from './journal-legacy-retirement-outcome'
import type { JournalSqlMaintenanceResult } from './journal-sql-maintenance'
import type { JournalSqlOwner } from './journal-sql-owner'

export type RetirementState = Extract<
  JournalSqlMaintenanceResult,
  { kind: 'legacy-retirement-state' }
>

/** The cleanup's saved state, read through the store's writer. */
export async function readRetirementState(
  writer: Pick<JournalSqlOwner, 'maintain'>
): Promise<RetirementState> {
  const saved = await writer.maintain({ kind: 'legacy-retirement-state' })
  if (
    !saved ||
    typeof saved !== 'object' ||
    !('kind' in saved) ||
    saved.kind !== 'legacy-retirement-state'
  ) {
    throw new Error('legacy retirement state is unavailable')
  }
  return saved
}

// The saved records the cleanup reads back: when it may run, a WAL a cut-short removal left, the
// held record a proof leaves in a build that keeps the file, and what an outcome says about a finished proof.

/** Time spent waiting (for idle, or pacing), so active time counts only the work. */
export function legacyProofWaits(): {
  timed: <A extends unknown[], R>(wait: (...args: A) => Promise<R>) => (...args: A) => Promise<R>
  waitedMs: () => number
} {
  let waited = 0
  return {
    timed:
      (wait) =>
      async (...args) => {
        const started = performance.now()
        try {
          return await wait(...args)
        } finally {
          waited += performance.now() - started
        }
      },
    waitedMs: () => waited
  }
}

/**
 * Absent means a release before this record copied the profile, which is always earlier; a copy
 * made without a known version waits only for the first launch that knows its own.
 */
export function laterVersion(running: string, convertedBy: string | null): boolean {
  return (
    isValidAppVersion(running) &&
    (convertedBy === null ||
      !isValidAppVersion(convertedBy) ||
      compareAppVersions(running, convertedBy) > 0)
  )
}

/** The WAL a saved retirement proved absorbed, so a removal cut short after the main file can finish. */
export function absorbedWal(
  saved: string | null
): { size: string; ino?: string; mtimeNs?: string } | undefined {
  try {
    const record: unknown = saved ? JSON.parse(saved) : null
    if (!isRecord(record) || record.phase !== 'retiring' || typeof record.proof !== 'string') {
      return undefined
    }
    const proof: unknown = JSON.parse(record.proof)
    const wal = isRecord(proof) && isRecord(proof.wal) ? proof.wal : undefined
    return wal?.kind === 'nonempty' &&
      typeof wal.size === 'string' &&
      typeof wal.ino === 'string' &&
      typeof wal.mtimeNs === 'string'
      ? { size: wal.size, ino: wal.ino, mtimeNs: wal.mtimeNs }
      : undefined
  } catch {
    return undefined
  }
}

/** This store saved that it was deleting the original: written durably before the unlink. */
export function deletedBefore(saved: string | null): boolean {
  try {
    const record: unknown = saved ? JSON.parse(saved) : null
    return isRecord(record) && record.phase === 'retiring'
  } catch {
    return false
  }
}

/** The original and its WAL as the proof read them: what deleting it frees. */
export function sourceBytes(observation: { proof: string; walBytes: string }): number | null {
  try {
    const receipt: unknown = JSON.parse(observation.proof)
    const main =
      isRecord(receipt) && isRecord(receipt.main) ? Number(receipt.main.size) : Number.NaN
    return Number.isFinite(main) ? main + (Number(observation.walBytes) || 0) : null
  } catch {
    return null
  }
}

/** A held record of the proof of this original into this store, under this build's layout. */
export function heldFor(
  saved: string | null,
  observation: LegacyProofObservation
): LegacySourceHeld | null {
  try {
    const record: unknown = saved ? JSON.parse(saved) : null
    if (
      !isRecord(record) ||
      record.phase !== 'held' ||
      record.layout !== LEGACY_PROOF_LAYOUT ||
      record.proof !== observation.proof ||
      record.store !== observation.store
    ) {
      return null
    }
    const count = (name: string) => {
      const value = isRecord(record.counts) ? record.counts[name] : undefined
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
    }
    return {
      version: 2,
      phase: 'held',
      layout: LEGACY_PROOF_LAYOUT,
      proof: observation.proof,
      store: observation.store,
      counts: !isRecord(record.counts)
        ? null
        : {
            chats: count('chats'),
            alreadyConverted: count('alreadyConverted'),
            newlyConverted: count('newlyConverted'),
            deletedHere: count('deletedHere'),
            drafts: count('drafts'),
            originals: count('originals'),
            copies: count('copies')
          },
      whole: record.whole === true
    }
  } catch {
    return null
  }
}

export function provenOutcome(
  outcome: 'proof_complete' | 'deleted' | 'delete_failed',
  proven: LegacySourceHeld,
  observation: { proof: string; walBytes: string },
  activeMs: number | null,
  resumed: boolean
): Partial<LegacyJournalRetirementOutcome> {
  return {
    outcome,
    // Counts that cover every page; a walk resumed from progress without them covers fewer.
    completeness: proven.whole ? 'complete' : 'partial',
    cumulative: proven.whole && proven.counts !== null,
    resumed,
    counts: proven.counts,
    sourceBytes: sourceBytes(observation),
    activeMs
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The original as the last older-Orca reconcile absorbed it, so the content proof reads what this
 * store has already taken in; null keeps the original for this attempt.
 */
export async function observeLegacySource(
  filename: string,
  directory: string,
  saved: { kept: boolean; receipt: string | null }
): Promise<(LegacyProofObservation & { walBytes: string }) | null> {
  const current = await readJournalLegacySourceReceipt(filename)
  if (
    !saved.kept ||
    current.disposition !== 'copied-source' ||
    !sameJournalLegacySource(saved.receipt ?? undefined, current)
  ) {
    return null
  }
  if (await legacyFilePresent(`${filename}-journal`)) {
    throw new JournalLegacyRetentionError('legacy rollback journal retained')
  }
  return {
    proof: JSON.stringify(current),
    // The store file alone: its WAL is recreated on every open, which no refusal should outlive.
    store: await legacyDestinationMain(journalDomainDatabasePath(directory)),
    walBytes: current.wal.kind === 'empty' ? '0' : current.wal.size
  }
}

/** The original and the store are still the ones the proof read. */
export async function legacySourceUnchanged(
  filename: string,
  directory: string,
  observation: LegacyProofObservation
): Promise<boolean> {
  return (
    JSON.stringify(await readJournalLegacySourceReceipt(filename)) === observation.proof &&
    (await legacyDestinationMain(journalDomainDatabasePath(directory))) === observation.store
  )
}

export type FinishedWalk = LegacyProofObservation & { walked: JournalLegacyProof['walked'] }

/** The walk that finished for this original into this store, if one did. */
export function walkedFor(
  finished: FinishedWalk | undefined,
  observation: LegacyProofObservation | undefined
): JournalLegacyProof['walked'] | undefined {
  const same = finished?.proof === observation?.proof && finished?.store === observation?.store
  return same ? finished?.walked : undefined
}
