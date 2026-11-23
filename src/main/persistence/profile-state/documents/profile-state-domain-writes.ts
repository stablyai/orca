import { withProfileStateWriteTransaction } from '../database/profile-state-write-transaction'
import type Database from '../../../sqlite/sync-database'
import { readCurrentAutomationRunsState } from '../automation-runs/profile-state-automation-runs-storage'
import {
  PROFILE_STATE_DOCUMENT_VERSION,
  PROFILE_STATE_META_REVISION
} from '../database/profile-state-database-schema'
import './profile-state-documents'
import {
  ProfileStateRevisionConflictError,
  isRecord,
  validateProfileStateDocumentRow
} from './profile-state-document-validation'
import {
  readProfileStateRevision,
  assertProfileStateDocumentRevision
} from '../database/profile-state-revision'
import { clearProfileStateAutomationRuns } from '../automation-runs/profile-state-automation-runs'
import {
  applyProfileStateAutomationRuns,
  prepareProfileStateAutomationRunsDelta,
  prepareProfileStateAutomationRunsReplacement
} from '../automation-runs/profile-state-automation-runs-writer'
import {
  deleteProfileStateDomainParts,
  readSplitDomainWriteState,
  writeProfileStateDomainParts
} from '../document-parts/profile-state-document-parts-storage'
import type { CommittedPartsTree } from '../document-parts/profile-state-parts-tree-storage'
import type {
  PreparedPartsPatch,
  ProfileStateDomainPatching
} from './profile-state-split-domain-writes'
import { isProfileStateSplitDomain } from '../document-parts/profile-state-document-parts'
import {
  prepareProfileStateDomainPatches,
  type ProfileStateDomainPatch
} from './profile-state-domain-patches'
import {
  prepareProfileStateDomainMutation,
  validateProfileStateDomainTransaction,
  type PreparedProfileStateMutation
} from './profile-state-domain-write-validation'

export type ProfileStateDomainReplacement = {
  domain: string
  /** Null deletes the row; JSON "null" remains an explicit value. */
  payload: string | null
  /** Fence the revision read before constructing this replacement. */
  expectedRevision: number
  domainVersion?: number
  now?: () => number
}

export type ProfileStateDomainMutation = Omit<ProfileStateDomainReplacement, 'expectedRevision'>

/** One shared revision check makes cross-domain mutations an atomic compare-and-swap. */
export type ProfileStateDomainTransaction = {
  expectedRevision: number
  replacements: readonly ProfileStateDomainMutation[]
  /** Enable selective run-row updates from Store's changed projection. */
  automationRunsAfter?: readonly unknown[]
  /** Changed entries of split domains, applied to their stored copies in this transaction. */
  patches?: readonly ProfileStateDomainPatch[]
  /** The writer's patch support; only the writer worker sends patches. */
  patching?: ProfileStateDomainPatching
}

function rejectPatch(): never {
  throw new Error('Profile state patches can only be applied by the writer')
}

export type ProfileStateDomainWriteResult = {
  changed: boolean
  revision: number
}

export type ProfileStateDomainTransactionResult = ProfileStateDomainWriteResult & {
  changedDomains: readonly string[]
}

/** BEGIN IMMEDIATE fences stale writers; only this domain changes, and null deletes its row. */
export function writeProfileStateDomain(
  db: Database.Database,
  replacement: ProfileStateDomainReplacement
): ProfileStateDomainWriteResult {
  const result = writeProfileStateDomains(db, {
    expectedRevision: replacement.expectedRevision,
    replacements: [
      {
        domain: replacement.domain,
        payload: replacement.payload,
        domainVersion: replacement.domainVersion,
        now: replacement.now
      }
    ]
  })
  return { changed: result.changed, revision: result.revision }
}

/** All changed rows share one revision; any validation/write/commit failure rolls back the whole set. */
export function writeProfileStateDomains(
  db: Database.Database,
  transaction: ProfileStateDomainTransaction
): ProfileStateDomainTransactionResult {
  validateProfileStateDomainTransaction(transaction)

  const prepared = transaction.replacements.map((replacement) =>
    prepareProfileStateDomainMutation(replacement)
  )
  const patches = prepareProfileStateDomainPatches(transaction.patches ?? [])
  if (patches.some(({ domain }) => prepared.some((mutation) => mutation.domain === domain))) {
    throw new Error('Profile state domain transaction patches a replaced domain')
  }
  const { patching } = transaction
  const preparePatch = patching?.prepare ?? rejectPatch
  if (patches.length > 0 && !patching) {
    rejectPatch()
  }

  // Split session domains as stored once this commits, for the writer's next patch.
  const committed = new Map<string, CommittedPartsTree>()
  const result = withProfileStateWriteTransaction(db, () => {
    committed.clear()
    const actualRevision = readProfileStateRevision(db)
    if (actualRevision !== transaction.expectedRevision) {
      throw new ProfileStateRevisionConflictError(transaction.expectedRevision, actualRevision)
    }
    const currentAutomationRuns = readCurrentAutomationRunsState(db, actualRevision)

    const updates: PreparedProfileStateMutation[] = []
    const splitStates = new Map<string, ReturnType<typeof readSplitDomainWriteState>>()
    const admit = (mutation: PreparedProfileStateMutation): void => {
      const splitState = readSplitDomainWriteState(db, mutation.domain)
      splitStates.set(mutation.domain, splitState)
      if (splitState.kind === 'parts') {
        // Compare by hash; the legacy row is a stale downgrade copy and is not re-read.
        assertProfileStateDocumentRevision(splitState.revision, actualRevision, mutation.domain)
        if (mutation.payload === null || mutation.payloadHash !== splitState.contentHash) {
          updates.push(mutation)
        }
        return
      }
      const existing = db
        .prepare(
          `SELECT domain, payload, domain_version, revision, updated_at, content_hash
           FROM profile_state_documents WHERE domain = ?`
        )
        .get(mutation.domain)
      const existingRow =
        existing === undefined
          ? undefined
          : validateProfileStateDocumentRow(existing, {
              // Identical incoming payloads already passed JSON validation.
              validateJson: !(isRecord(existing) && existing.payload === mutation.payload)
            })
      if (existingRow) {
        assertProfileStateDocumentRevision(existingRow.revision, actualRevision, mutation.domain)
      }
      if (mutation.domain === 'automationRuns') {
        // Matching canonical history hashes avoid rebuilding the projection.
        if (
          currentAutomationRuns.presence === 'array' &&
          mutation.payload?.startsWith('[') &&
          currentAutomationRuns.contentHash === mutation.payloadHash
        ) {
          return
        }
        const normalized = prepareProfileStateAutomationRunsReplacement(
          db,
          mutation,
          actualRevision
        )
        if (normalized !== undefined) {
          if (normalized.changed) {
            updates.push({ ...mutation, automationRuns: normalized })
          }
          return
        }
      }
      const unchanged =
        (mutation.payload === null && existingRow === undefined) ||
        (mutation.payload !== null && existingRow?.payload === mutation.payload)
      if (!unchanged) {
        updates.push(mutation)
      }
    }
    for (const mutation of prepared) {
      admit(mutation)
    }
    const partsUpdates: PreparedPartsPatch[] = []
    for (const patch of patches) {
      const mutation = preparePatch(db, patch)
      if (!('kind' in mutation)) {
        admit(mutation)
        continue
      }
      const splitState = readSplitDomainWriteState(db, mutation.domain)
      if (splitState.kind !== 'parts') {
        throw new Error(`Profile state patch lost its stored parts: ${mutation.domain}`)
      }
      assertProfileStateDocumentRevision(splitState.revision, actualRevision, mutation.domain)
      splitStates.set(mutation.domain, splitState)
      if (mutation.contentHash === splitState.contentHash) {
        committed.set(mutation.domain, mutation.previous)
      } else {
        partsUpdates.push(mutation)
      }
    }
    if (transaction.automationRunsAfter !== undefined) {
      const delta = prepareProfileStateAutomationRunsDelta(
        db,
        transaction.automationRunsAfter,
        PROFILE_STATE_DOCUMENT_VERSION,
        Date.now,
        actualRevision
      )
      if (delta === undefined) {
        // Histories per-run rows can't hold (e.g. duplicate run ids) save as one replacement row.
        admit(
          prepareProfileStateDomainMutation({
            domain: 'automationRuns',
            payload: JSON.stringify(transaction.automationRunsAfter),
            domainVersion: PROFILE_STATE_DOCUMENT_VERSION
          })
        )
      } else if (delta.changed) {
        updates.push({
          domain: 'automationRuns',
          payload: null,
          domainVersion: PROFILE_STATE_DOCUMENT_VERSION,
          payloadHash: null,
          automationRuns: delta
        })
      }
    }

    if (updates.length === 0 && partsUpdates.length === 0) {
      return { changed: false, revision: actualRevision, changedDomains: [] }
    }

    const nextRevision = actualRevision + 1
    for (const patch of partsUpdates) {
      committed.set(patch.domain, patching!.writePatch(db, patch, nextRevision))
    }
    for (const mutation of updates) {
      if (mutation.automationRuns) {
        applyProfileStateAutomationRuns(db, mutation.automationRuns, nextRevision)
        continue
      }
      if (mutation.domain === 'automationRuns') {
        clearProfileStateAutomationRuns(db)
      }
      if (mutation.payload === null) {
        db.prepare('DELETE FROM profile_state_documents WHERE domain = ?').run(mutation.domain)
        deleteProfileStateDomainParts(db, mutation.domain)
      } else {
        const updatedAt = (mutation.now ?? Date.now)()
        if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
          throw new Error(`Profile state domain update timestamp is invalid: ${mutation.domain}`)
        }
        const splitState = splitStates.get(mutation.domain)
        const { payload } = mutation
        const writeParts = (legacyRevision: number, diffExisting: boolean): boolean => {
          const written = writeProfileStateDomainParts(db, {
            domain: mutation.domain,
            payload,
            value: mutation.splitDomainValue,
            payloadHash: mutation.payloadHash!,
            domainVersion: mutation.domainVersion,
            revision: nextRevision,
            updatedAt,
            legacyRevision,
            diffExisting
          })
          const kept =
            written &&
            patching?.keepWritten(mutation.domain, written, {
              contentHash: mutation.payloadHash!,
              revision: nextRevision,
              legacyRevision
            })
          if (kept) {
            committed.set(mutation.domain, kept)
          }
          return written !== undefined
        }
        if (splitState?.kind === 'parts' && writeParts(splitState.legacyRevision, true)) {
          continue
        }
        db.prepare(
          `INSERT INTO profile_state_documents
           (domain, payload, domain_version, revision, updated_at, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(domain) DO UPDATE SET
             payload = excluded.payload,
             domain_version = excluded.domain_version,
             revision = excluded.revision,
             updated_at = excluded.updated_at,
             content_hash = excluded.content_hash`
        ).run(
          mutation.domain,
          mutation.payload,
          mutation.domainVersion,
          nextRevision,
          updatedAt,
          mutation.payloadHash
        )
        if (isProfileStateSplitDomain(mutation.domain)) {
          // The legacy row now matches; later writes touch only the parts that change.
          writeParts(nextRevision, false)
        }
      }
    }
    db.prepare(
      `INSERT INTO profile_state_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(PROFILE_STATE_META_REVISION, String(nextRevision))
    return {
      changed: true,
      revision: nextRevision,
      changedDomains: [...updates, ...partsUpdates].map(({ domain }) => domain)
    }
  })
  // Whole session writes are cached too, so the next patch doesn't re-read what was just written.
  patching?.remember(db, committed)
  return result
}
