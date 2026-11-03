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
    // Volatile bookkeeping: scanId changes on every scan and restamps change
    // with the caller; neither is list content.
    .update(
      JSON.stringify({
        ...result,
        scannedAt: undefined,
        scanId: undefined,
        fingerprint: undefined
      })
    )
    .digest('hex')
  return !force && afterFingerprint === fingerprint
    ? { sessions: [], issues: [], scannedAt: result.scannedAt, fingerprint, unchanged: true }
    : { ...result, fingerprint }
}
