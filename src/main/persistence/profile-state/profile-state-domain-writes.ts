import { withProfileStateWriteTransaction } from './profile-state-write-transaction'
import type Database from '../../sqlite/sync-database'
import { readCurrentAutomationRunsState } from './profile-state-automation-runs-storage'
import {
  PROFILE_STATE_DOCUMENT_VERSION,
  PROFILE_STATE_META_REVISION
} from './profile-state-database-schema'
import {
  ProfileStateRevisionConflictError,
  readProfileStateRevision
} from './profile-state-documents'
import {
  applyProfileStateAutomationRuns,
  clearProfileStateAutomationRuns,
  prepareProfileStateAutomationRunsDelta,
  prepareProfileStateAutomationRunsReplacement
} from './profile-state-automation-runs'
import { isRecord, validateProfileStateDocumentRow } from './profile-state-document-validation'
import { assertProfileStateDocumentRevision } from './profile-state-revision'
import {
  deleteProfileStateDomainParts,
  readSplitDomainWriteState,
  writeProfileStateDomainParts
} from './profile-state-document-parts-storage'
import { isProfileStateSplitDomain } from './profile-state-document-parts'
import {
  prepareProfileStateDomainMutation,
  validateProfileStateDomainTransaction,
  type PreparedProfileStateMutation
} from './profile-state-domain-write-validation'

export { ProfileStateRevisionConflictError } from './profile-state-documents'

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

  const prepared = transaction.replacements.map(prepareProfileStateDomainMutation)

  return withProfileStateWriteTransaction(db, () => {
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

    if (updates.length === 0) {
      return { changed: false, revision: actualRevision, changedDomains: [] }
    }

    const nextRevision = actualRevision + 1
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
        if (
          splitState?.kind === 'parts' &&
          writeProfileStateDomainParts(db, {
            domain: mutation.domain,
            payload: mutation.payload,
            value: mutation.splitDomainValue,
            payloadHash: mutation.payloadHash!,
            domainVersion: mutation.domainVersion,
            revision: nextRevision,
            updatedAt,
            legacyRevision: splitState.legacyRevision,
            diffExisting: true
          })
        ) {
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
          writeProfileStateDomainParts(db, {
            domain: mutation.domain,
            payload: mutation.payload,
            value: mutation.splitDomainValue,
            payloadHash: mutation.payloadHash!,
            domainVersion: mutation.domainVersion,
            revision: nextRevision,
            updatedAt,
            legacyRevision: nextRevision,
            diffExisting: false
          })
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
      changedDomains: updates.map(({ domain }) => domain)
    }
  })
}
