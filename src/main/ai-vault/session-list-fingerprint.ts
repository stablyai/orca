import { createHash } from 'node:crypto'
import type { AiVaultListResult } from '../../shared/ai-vault-types'

export function conditionalAiVaultListResult(
  result: AiVaultListResult,
  afterFingerprint: string | null | undefined,
  force = false
): AiVaultListResult {
  if (afterFingerprint === undefined) {
    return result
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ ...result, scannedAt: undefined }))
    .digest('hex')
  return !force && afterFingerprint === fingerprint
    ? { sessions: [], issues: [], scannedAt: result.scannedAt, fingerprint, unchanged: true }
    : { ...result, fingerprint }
}
