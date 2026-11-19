import type Database from '../../../sqlite/sync-database'
import { writeProfileStateDomainParts } from '../document-parts/profile-state-document-parts-storage'
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
  remember: (db: Database.Database, trees: ReadonlyMap<string, CommittedPartsTree>) => void
}

/** Split session domains as stored once the transaction commits, for the writer's next patch. */
export type CommittedSplitDomains = Map<string, CommittedPartsTree>

export function writePartsPatch(
  db: Database.Database,
  patch: PreparedPartsPatch,
  revision: number,
  committed: CommittedSplitDomains
): void {
  committed.set(
    patch.domain,
    writeCommittedPartsTree(db, patch.domain, patch.previous, patch.previous.root, {
      domainVersion: patch.domainVersion,
      revision,
      updatedAt: Date.now(),
      contentHash: patch.contentHash,
      legacyRevision: patch.previous.legacyRevision
    })
  )
}

/** Stores a whole split domain as parts; false when it can't be split and needs a legacy row. */
export function writeWholeSplitDomain(
  db: Database.Database,
  mutation: PreparedProfileStateMutation & { payload: string },
  write: { revision: number; updatedAt: number; legacyRevision: number; diffExisting: boolean },
  committed: CommittedSplitDomains
): boolean {
  const written = writeProfileStateDomainParts(db, {
    domain: mutation.domain,
    payload: mutation.payload,
    value: mutation.splitDomainValue,
    payloadHash: mutation.payloadHash!,
    domainVersion: mutation.domainVersion,
    ...write
  })
  // Session domains are patched next, so keep what was just written instead of reading it back.
  if (written && isWorkspaceSessionDomain(mutation.domain)) {
    committed.set(mutation.domain, {
      root: partsTreeFromWrittenParts(mutation.domain, written),
      rows: written.rows,
      contentHash: mutation.payloadHash!,
      revision: write.revision,
      legacyRevision: write.legacyRevision
    })
  }
  return written !== undefined
}
