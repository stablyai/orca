import type Database from '../../../sqlite/sync-database'
import { readSplitDomainWriteState } from '../document-parts/profile-state-document-parts-storage'
import { PROFILE_STATE_SPLIT_DOMAIN_DEPTHS } from '../document-parts/profile-state-document-parts'
import { applyPatchToPartsTree } from '../document-parts/profile-state-parts-tree'
import {
  hashPartsTree,
  readCommittedPartsTree,
  type CommittedPartsTree
} from '../document-parts/profile-state-parts-tree-storage'
import { PROFILE_STATE_DOCUMENT_VERSION } from '../database/profile-state-database-schema'
import { validateProfileStateDocumentRow } from './profile-state-document-validation'
import {
  applyProfileStateDomainPatch,
  type PreparedProfileStateDomainPatch
} from './profile-state-domain-patches'
import {
  prepareProfileStateDomainMutation,
  type PreparedProfileStateMutation
} from './profile-state-domain-write-validation'
import {
  keepWrittenSessionParts,
  writePartsPatch,
  type PreparedPartsPatch,
  type ProfileStateDomainPatching
} from './profile-state-split-domain-writes'

// The writer's own copy of each patched domain as last committed, so the next patch skips
// reading, verifying and splitting the stored parts. Checked against the stored revision and hash before use.
let committedTrees = new WeakMap<Database.Database, Map<string, CommittedPartsTree>>()

function takeCommittedTree(
  db: Database.Database,
  domain: string,
  stored: { contentHash: string; revision: number; legacyRevision: number }
): CommittedPartsTree {
  const committed = committedTrees.get(db)?.get(domain)
  // Patching mutates the tree, so it leaves the cache until the transaction commits.
  committedTrees.get(db)?.delete(domain)
  return committed?.revision === stored.revision &&
    committed.contentHash === stored.contentHash &&
    committed.legacyRevision === stored.legacyRevision
    ? committed
    : readCommittedPartsTree(db, domain, stored)
}

/** Call after the transaction that wrote these domains committed. */
export function rememberCommittedPartsTrees(
  db: Database.Database,
  trees: ReadonlyMap<string, CommittedPartsTree>
): void {
  let domains = committedTrees.get(db)
  if (!domains) {
    domains = new Map()
    committedTrees.set(db, domains)
  }
  for (const [domain, tree] of trees) {
    domains.set(domain, tree)
  }
}

function readLegacyDomainValue(db: Database.Database, domain: string): unknown {
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

/** The patched domain, prepared here in the writer so the main thread never serializes it. */
export function preparePatchedProfileStateDomain(
  db: Database.Database,
  patch: PreparedProfileStateDomainPatch
): PreparedProfileStateMutation | PreparedPartsPatch {
  const split = readSplitDomainWriteState(db, patch.domain)
  if (split.kind === 'parts') {
    const previous = takeCommittedTree(db, patch.domain, split)
    const depth = PROFILE_STATE_SPLIT_DOMAIN_DEPTHS.get(patch.domain)!
    const changed = applyPatchToPartsTree(previous.root, patch, depth)
    return {
      kind: 'parts',
      domain: patch.domain,
      domainVersion: PROFILE_STATE_DOCUMENT_VERSION,
      previous,
      contentHash: changed ? hashPartsTree(previous.root) : previous.contentHash
    }
  }
  // The legacy row is authoritative (an older build wrote it): rebuild the whole domain once.
  const value = applyProfileStateDomainPatch(readLegacyDomainValue(db, patch.domain), patch)
  return prepareProfileStateDomainMutation(
    { domain: patch.domain, payload: JSON.stringify(value) },
    { value }
  )
}

/** Patch support for the writer worker; main never applies patches. */
export const profileStateWriterPatching: ProfileStateDomainPatching = {
  prepare: preparePatchedProfileStateDomain,
  writePatch: writePartsPatch,
  keepWritten: keepWrittenSessionParts,
  remember: rememberCommittedPartsTrees
}

/** After a complete write: main saves the session whole next, so the old copies only hold memory. */
export function forgetCommittedProfileStateDomains(): void {
  committedTrees = new WeakMap()
}
