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
import type { ProfileStateDomainPatching } from './profile-state-domain-writes'

type CommittedDomain = { contentHash: string; value: unknown }

// The writer's own parsed copy of each patched domain as last committed, so the next patch skips
// reading, verifying and parsing the stored parts. Checked against the stored hash before use.
let committedDomains = new WeakMap<Database.Database, Map<string, CommittedDomain>>()

function takeCommittedValue(db: Database.Database, domain: string, contentHash: string): unknown {
  const committed = committedDomains.get(db)?.get(domain)
  // Patching mutates the value, so it leaves the cache until the transaction commits.
  committedDomains.get(db)?.delete(domain)
  return committed?.contentHash === contentHash ? committed.value : undefined
}

/** Call after the transaction that wrote these patched domains committed. */
export function rememberPatchedProfileStateDomains(
  db: Database.Database,
  mutations: readonly PreparedProfileStateMutation[]
): void {
  let domains = committedDomains.get(db)
  if (!domains) {
    domains = new Map()
    committedDomains.set(db, domains)
  }
  for (const { domain, payloadHash, splitDomainValue } of mutations) {
    if (payloadHash !== null && splitDomainValue !== undefined) {
      domains.set(domain, { contentHash: payloadHash, value: splitDomainValue })
    }
  }
}

function readStoredDomainValue(db: Database.Database, domain: string): unknown {
  const split = readSplitDomainWriteState(db, domain)
  if (split.kind === 'parts') {
    const committed = takeCommittedValue(db, domain, split.contentHash)
    if (committed !== undefined) {
      return committed
    }
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
  return prepareProfileStateDomainMutation(
    { domain: patch.domain, payload: JSON.stringify(value) },
    { value }
  )
}

/** Patch support for the writer worker; main never applies patches. */
export const profileStateWriterPatching: ProfileStateDomainPatching = {
  prepare: preparePatchedProfileStateDomain,
  remember: rememberPatchedProfileStateDomains
}

/** After a complete write: main saves the session whole next, so the old copies only hold memory. */
export function forgetCommittedProfileStateDomains(): void {
  committedDomains = new WeakMap()
}
