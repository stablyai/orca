import type { AiVaultAgent, AiVaultScanIssue } from '../../shared/ai-vault-types'
import type { SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import type { SessionSearchStore } from './session-search-store'

/** Keep providers with discovered files but no indexed sessions visible. */
export function recordSearchDiscovered(
  store: SessionSearchStore,
  discoveries: readonly SessionFileDiscovery[],
  issues: readonly AiVaultScanIssue[]
): void {
  const files = new Map<AiVaultAgent, number>()
  for (const discovery of discoveries) {
    files.set(discovery.agent, (files.get(discovery.agent) ?? 0) + discovery.files.length)
  }
  const failures = new Map<AiVaultAgent, number>()
  for (const issue of issues) {
    if (issue.kind !== 'notice') {
      failures.set(issue.agent, (failures.get(issue.agent) ?? 0) + 1)
    }
  }
  for (const agent of new Set([...files.keys(), ...failures.keys()])) {
    store.setDiscovered(agent, files.get(agent) ?? 0, failures.get(agent) ?? 0)
  }
}
