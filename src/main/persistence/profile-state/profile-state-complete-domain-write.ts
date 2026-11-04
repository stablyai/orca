import type { SurfaceKey } from '../../../shared/workspace-surfaces/surface-content'
import type Database from '../../sqlite/sync-database'
import type { ProfileStateDomainReplacement } from '../loading-store/profile-state-authority'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import {
  validateProfileStateDomainTransaction,
  prepareProfileStateDomainMutation
} from './profile-state-domain-write-validation'
import { readProfileStateRevision, importProfileStateJson } from './profile-state-documents'
import { buildCompleteDocumentReplacements } from './profile-state-complete-replacements'

export function writeCompleteProfileStateDomains(
  openDb: () => Database.Database,
  expectedRevision: number | undefined,
  replacements: readonly ProfileStateDomainReplacement[],
  committedSurfaces?: (keys: readonly SurfaceKey[]) => void
): number {
  if (!Array.isArray(replacements) || replacements.length > 0) {
    validateProfileStateDomainTransaction({
      expectedRevision: expectedRevision ?? 0,
      replacements
    })
  }
  const db = openDb()
  const currentRevision = readProfileStateRevision(db)
  const complete = buildCompleteDocumentReplacements(db, replacements)
  if (currentRevision === 0 || complete.length === 0) {
    // Validate fragments independently so splicing cannot conceal malformed JSON.
    for (const replacement of replacements) {
      prepareProfileStateDomainMutation(replacement)
    }
    const rawJson = `{${replacements
      .filter(({ payload }) => payload !== null)
      .map(({ domain, payload }) => `${JSON.stringify(domain)}:${payload}`)
      .join(',')}}`
    return importProfileStateJson(db, rawJson, {
      expectedRevision: expectedRevision
    })
  }
  const result = writeProfileStateDomains(db, {
    expectedRevision: expectedRevision ?? currentRevision,
    replacements: complete
  })
  committedSurfaces?.(result.surfaceInvalidations ?? [])
  return result.revision
}
