import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  nextScanObservationOrder,
  recordScanOutcome
} from '../../ai-vault/scan-lifecycle/ai-vault-scan-recovery'
export async function scanRemoteLeg(
  signal: AbortSignal | undefined,
  key: string,
  force: boolean,
  scan: () => Promise<AiVaultListResult>
): Promise<AiVaultListResult> {
  // Old peers keep forced unary requests; cached ordinary responses prove no freshness.
  const order = force ? nextScanObservationOrder() : 0
  try {
    const result = await scan()
    recordScanOutcome(signal, key, { ok: true, result, order })
    return result
  } catch (error) {
    recordScanOutcome(signal, key, { ok: false, error, order })
    throw error
  }
}
