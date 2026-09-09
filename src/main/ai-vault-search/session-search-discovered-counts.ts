import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'

/** What one sweep saw for one agent, before anything was read. */
export type SessionSearchDiscoveredCount = { files: number; failures: number }

/**
 * Keeps a provider with discovered transcripts but no indexed rows visible.
 * Without it a provider whose every file failed to parse is indistinguishable
 * from one that is not installed, and the difference is the whole question a
 * coverage report answers.
 */
export function sessionSearchDiscoveredCounts(
  discoveries: readonly SessionFileDiscovery[],
  issues: readonly AiVaultScanIssue[]
): Map<AiVaultAgent, SessionSearchDiscoveredCount> {
  const counts = new Map<AiVaultAgent, SessionSearchDiscoveredCount>()
  const entry = (agent: AiVaultAgent): SessionSearchDiscoveredCount => {
    const existing = counts.get(agent) ?? { files: 0, failures: 0 }
    counts.set(agent, existing)
    return existing
  }
  for (const discovery of discoveries) {
    entry(discovery.agent).files += discovery.files.length
  }
  for (const issue of issues) {
    // 'notice' rows are scanner commentary, never a failed read.
    if (issue.kind !== 'notice') {
      entry(issue.agent).failures += 1
    }
  }
  return counts
}
