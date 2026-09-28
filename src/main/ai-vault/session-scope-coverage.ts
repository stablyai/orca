import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { CLAUDE_CWD_BUCKET_LAYOUT, PI_CWD_BUCKET_LAYOUT } from './session-cwd-bucket-layouts'
import type { SessionFileDiscovery } from './session-scanner-types'

// Agents whose on-disk layout names a directory per cwd, so a scope's older
// sessions can be found without reading every transcript's header.
export const CWD_BUCKET_LAYOUTS = [CLAUDE_CWD_BUCKET_LAYOUT, PI_CWD_BUCKET_LAYOUT]

const CWD_BUCKET_AGENTS: ReadonlySet<AiVaultAgent> = new Set(
  CWD_BUCKET_LAYOUTS.map((layout) => layout.agent)
)

/**
 * Whether the scan holds every session inside `scopePaths`, cap or no cap.
 *
 * Only cwd-bucket agents get the cap-bypassing scoped pass. For every other
 * agent a scoped view is a plain filter over the recency-capped list, so a
 * single transcript from one of them anywhere on the host means a deeper scan
 * can still surface in-scope rows. Callers pair this with "did the capped pass
 * actually fill its limit" — when it did not, nothing is missing either way.
 */
export function isAiVaultScopeFullyScanned(args: {
  scopePaths: readonly string[]
  discoveries: readonly SessionFileDiscovery[]
  scopePassBounded: boolean
}): boolean {
  if (args.scopePaths.length === 0 || args.scopePassBounded) {
    return false
  }
  return args.discoveries.every(
    (discovery) => discovery.files.length === 0 || CWD_BUCKET_AGENTS.has(discovery.agent)
  )
}
