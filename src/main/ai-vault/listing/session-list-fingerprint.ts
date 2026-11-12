import { createHash } from 'node:crypto'
import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'

export function conditionalAiVaultListResult(
  result: AiVaultListResult,
  afterFingerprint: string | null | undefined,
  force = false
): AiVaultListResult {
  if (afterFingerprint === undefined) {
    return result
  }
  // Why only the sessions: the scan id, time and issue wording change on every scan, so hashing
  // them would answer an unchanged history as changed. A reused body keeps its earlier issues.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({ ...result, scannedAt: undefined, scanId: undefined, issues: undefined })
    )
    .digest('hex')
  return !force && afterFingerprint === fingerprint
    ? { sessions: [], issues: [], scannedAt: result.scannedAt, fingerprint, unchanged: true }
    : { ...result, fingerprint }
}
