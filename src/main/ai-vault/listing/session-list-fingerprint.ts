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
  // Why not the scan id, time or issue wording: they change on every scan, so hashing them would
  // answer an unchanged history as changed. Which issues there are (kind, agent, path) still
  // counts, so a new or cleared error reaches clients that reuse an unchanged body.
  const issues = result.issues.map(({ kind, agent, path }) => [kind ?? 'error', agent, path])
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ ...result, scannedAt: undefined, scanId: undefined, issues }))
    .digest('hex')
  return !force && afterFingerprint === fingerprint
    ? { sessions: [], issues: [], scannedAt: result.scannedAt, fingerprint, unchanged: true }
    : { ...result, fingerprint }
}
