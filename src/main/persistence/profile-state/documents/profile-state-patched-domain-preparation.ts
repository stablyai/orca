import type Database from '../../../sqlite/sync-database'
import { assertProfileStateDocumentRevision } from '../database/profile-state-revision'
import {
  readSplitDomainWriteState,
  readProfileStateSplitDocument,
  type ProfileStateExistingDocumentParts
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

export function preparePatchedProfileStateDomains(
  db: Database.Database,
  patches: readonly PreparedProfileStateDomainPatch[],
  actualRevision: number
): PreparedProfileStateMutation[] {
  const mutations: PreparedProfileStateMutation[] = []
  for (const patch of patches) {
    const splitState = readSplitDomainWriteState(db, patch.domain)
    if (splitState.kind === 'parts') {
      assertProfileStateDocumentRevision(splitState.revision, actualRevision, patch.domain)
      if (patch.operations.length === 0) {
        continue
      }
    }
    let base: unknown
    let existingParts: ProfileStateExistingDocumentParts | undefined
    if (splitState.kind === 'parts') {
      existingParts = new Map()
      const document = readProfileStateSplitDocument(
        db,
        patch.domain,
        splitState.legacyRevision,
        existingParts
      )
      if (!document) {
        throw new Error('Profile state patch lost its authoritative parts')
      }
      base = JSON.parse(document.payload)
    } else {
      const row = db
        .prepare(
          `SELECT domain, payload, domain_version, revision, updated_at, content_hash
           FROM profile_state_documents WHERE domain = ?`
        )
        .get(patch.domain)
      if (row !== undefined) {
        const document = validateProfileStateDocumentRow(row, { retainParsedValue: true })
        assertProfileStateDocumentRevision(document.revision, actualRevision, patch.domain)
        base = document.value
      }
    }
    const value = applyProfileStateDomainPatch(base, patch)
    const payload = JSON.stringify(value)
    if (payload !== undefined) {
      mutations.push({
        ...prepareProfileStateDomainMutation({ domain: patch.domain, payload }, { value }),
        existingParts
      })
    }
  }
  return mutations
}
