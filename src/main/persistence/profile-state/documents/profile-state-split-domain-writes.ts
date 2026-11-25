import type Database from '../../../sqlite/sync-database'
import type { StoredProfileStateDomainParts } from '../document-parts/profile-state-document-parts-storage'
import {
  partsTreeFromWrittenParts,
  writeCommittedPartsTree,
  type CommittedPartsTree
} from '../document-parts/profile-state-parts-tree-storage'
import { isWorkspaceSessionDomain } from '../../workspace-session-domains'
import type { PreparedProfileStateDomainPatch } from './profile-state-domain-patches'
import type { PreparedProfileStateMutation } from './profile-state-domain-write-validation'

/** A patch applied to stored parts: only the touched parts change, nothing is re-serialized whole. */
export type PreparedPartsPatch = {
  kind: 'parts'
  domain: string
  domainVersion: number
  previous: CommittedPartsTree
  /** sha256 of the patched document; equals previous.contentHash when nothing changed. */
  contentHash: string
}

/** The writer's patch support; only the writer worker sends patches. */
export type ProfileStateDomainPatching = {
  prepare: (
    db: Database.Database,
    patch: PreparedProfileStateDomainPatch
  ) => PreparedProfileStateMutation | PreparedPartsPatch
  writePatch: (
    db: Database.Database,
    patch: PreparedPartsPatch,
    revision: number
  ) => CommittedPartsTree
  /** The tree for a session domain just written whole, so the next patch needs no read. */
  keepWritten: (
    domain: string,
    written: StoredProfileStateDomainParts,
    stored: { contentHash: string; revision: number; legacyRevision: number }
  ) => CommittedPartsTree | undefined
  remember: (db: Database.Database, trees: ReadonlyMap<string, CommittedPartsTree>) => void
}

export function writePartsPatch(
  db: Database.Database,
  patch: PreparedPartsPatch,
  revision: number
): CommittedPartsTree {
  return writeCommittedPartsTree(db, patch.domain, patch.previous, patch.previous.root, {
    domainVersion: patch.domainVersion,
    revision,
    updatedAt: Date.now(),
    contentHash: patch.contentHash,
    legacyRevision: patch.previous.legacyRevision
  })
}

export function keepWrittenSessionParts(
  domain: string,
  written: StoredProfileStateDomainParts,
  stored: { contentHash: string; revision: number; legacyRevision: number }
): CommittedPartsTree | undefined {
  if (!isWorkspaceSessionDomain(domain)) {
    return undefined
  }
  // Only an object session takes patches; anything else is stored as a lone root part.
  const [first] = written.parts
  return first?.key === '[]' && first.payload !== '{}'
    ? undefined
    : { root: partsTreeFromWrittenParts(domain, written), rows: written.rows, ...stored }
}
