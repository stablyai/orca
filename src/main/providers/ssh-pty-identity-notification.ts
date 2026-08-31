import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import { isForegroundProcessEvidence } from '../../shared/foreground-process-evidence'
import type { ForegroundProcessEvidence } from '../../shared/foreground-process-evidence'

export type AdmittedSshIdentityEvidence = {
  authorityGeneration: string
  observationEpoch: number
  rows: {
    id: string
    incarnationId: string
    foregroundProcessEvidence: ForegroundProcessEvidence
  }[]
}

export function parseSshIdentityEvidenceNotification(
  params: Readonly<Record<string, unknown>>,
  toAppPtyId: (id: string) => string
): AdmittedSshIdentityEvidence | null {
  const authorityGeneration = params.authorityGeneration
  const observationEpoch = params.observationEpoch
  const rows = params.rows
  if (
    typeof authorityGeneration !== 'string' ||
    authorityGeneration.length === 0 ||
    !Number.isSafeInteger(observationEpoch) ||
    (observationEpoch as number) < 0 ||
    !Array.isArray(rows)
  ) {
    return null
  }
  const admitted: AdmittedSshIdentityEvidence['rows'] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      return null
    }
    const input = row as Record<string, unknown>
    const evidence = input.foregroundProcessEvidence
    if (
      typeof input.id !== 'string' ||
      input.id.length === 0 ||
      !isPtyIncarnationId(input.incarnationId) ||
      !isForegroundProcessEvidence(evidence) ||
      evidence.authorityGeneration !== authorityGeneration ||
      evidence.observationEpoch !== observationEpoch
    ) {
      return null
    }
    let id: string
    try {
      id = toAppPtyId(input.id)
    } catch {
      return null
    }
    admitted.push({ id, incarnationId: input.incarnationId, foregroundProcessEvidence: evidence })
  }
  return { authorityGeneration, observationEpoch: observationEpoch as number, rows: admitted }
}
