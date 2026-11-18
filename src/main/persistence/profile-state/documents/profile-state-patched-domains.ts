import type Database from '../../../sqlite/sync-database'
import {
  readProfileStateSplitDocument,
  readSplitDomainWriteState
} from '../document-parts/profile-state-document-parts-storage'
import { validateProfileStateDocumentRow } from './profile-state-document-validation'
import {
  applyProfileStateDomainPatch,
  type PreparedProfileStateDomainPatch
} from './profile-state-domain-patches'
import {
  prepareProfileStateDomainMutation,
  type PreparedProfileStateMutation
} from './profile-state-domain-write-validation'

function readStoredDomainValue(db: Database.Database, domain: string): unknown {
  const split = readSplitDomainWriteState(db, domain)
  if (split.kind === 'parts') {
    const document = readProfileStateSplitDocument(db, domain, split.legacyRevision)
    if (!document) {
      throw new Error(`Profile state patch lost its stored parts: ${domain}`)
    }
    return JSON.parse(document.payload)
  }
  const row = db
    .prepare(
      `SELECT domain, payload, domain_version, revision, updated_at, content_hash
       FROM profile_state_documents WHERE domain = ?`
    )
    .get(domain)
  if (row === undefined) {
    throw new Error(`Profile state patch has no stored domain: ${domain}`)
  }
  return validateProfileStateDocumentRow(row, { retainParsedValue: true }).value
}

/** The whole patched domain, rebuilt here in the writer so the main thread never serializes it. */
export function preparePatchedProfileStateDomain(
  db: Database.Database,
  patch: PreparedProfileStateDomainPatch
): PreparedProfileStateMutation {
  const value = applyProfileStateDomainPatch(readStoredDomainValue(db, patch.domain), patch)
  return prepareProfileStateDomainMutation({ domain: patch.domain, payload: JSON.stringify(value) })
}
