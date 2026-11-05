import type { PersistedState } from '../../shared/persisted-state-types'
import { createHash } from 'node:crypto'
import {
  isSurfaceEvidenceDomain,
  surfaceEvidenceDocumentSchema,
  surfaceEvidenceKey
} from '../../shared/workspace-surfaces/surface-evidence-document'
import { ownerKeyBelongsToRepo, rekeyOwnerKey } from './profile-project-worktree-identity'
export { mergeSurfaceEvidenceDocuments as mergeProjectColdEvidence } from '../workspace-surfaces/surface-cold-evidence'

export function extractProjectColdEvidence(
  state: PersistedState,
  oldRepoId: string,
  newRepoId: string
): Record<string, unknown> {
  const documents: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(state)) {
    if (!isSurfaceEvidenceDomain(key)) {
      continue
    }
    const document = surfaceEvidenceDocumentSchema.parse(raw)
    if (!ownerKeyBelongsToRepo(document.value.workspaceId, oldRepoId)) {
      continue
    }
    const moved = structuredClone(document)
    moved.value.workspaceId =
      rekeyOwnerKey(oldRepoId, newRepoId, document.value.workspaceId) ?? document.value.workspaceId
    documents[
      surfaceEvidenceKey(moved, (value) => createHash('sha256').update(value).digest('hex'))
    ] = moved
  }
  return documents
}

export function removeProjectColdEvidence<T extends object>(state: T, repoId: string): T {
  const next = { ...state }
  for (const [key, raw] of Object.entries(state)) {
    if (
      isSurfaceEvidenceDomain(key) &&
      ownerKeyBelongsToRepo(surfaceEvidenceDocumentSchema.parse(raw).value.workspaceId, repoId)
    ) {
      Reflect.deleteProperty(next, key)
    }
  }
  return next
}
