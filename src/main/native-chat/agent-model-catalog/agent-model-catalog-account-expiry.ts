import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'

// The settings whose change swaps the account an agent's chats sign in with.
const ACCOUNT_SETTINGS = {
  claudeManagedAccounts: 'claude',
  activeClaudeManagedAccountId: 'claude',
  activeClaudeManagedAccountIdsByRuntime: 'claude',
  codexManagedAccounts: 'codex',
  activeCodexManagedAccountId: 'codex',
  activeCodexManagedAccountIdsByRuntime: 'codex'
} satisfies Partial<Record<keyof GlobalSettings, string>>

/** A chosen, re-signed or removed account changes what the probe found, so the next catalog
 *  read re-probes instead of serving the old account's answer. */
export function expireAgentModelCatalogFailuresForSettings(
  store: Pick<AgentModelCatalogStore, 'expireFailures'>,
  updates: Partial<GlobalSettings>
): void {
  const agents = new Set(
    Object.entries(ACCOUNT_SETTINGS)
      .filter(([key]) => key in updates)
      .map(([, agent]) => agent)
  )
  for (const agent of agents) {
    store.expireFailures(agent)
  }
}
