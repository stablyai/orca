import { ClaudeUsageStore, initClaudeUsagePath } from '../claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from '../codex-usage/store'
import { OpenCodeUsageStore, initOpenCodeUsagePath } from '../opencode-usage/store'
import { MuseUsageStore, initMuseUsagePath } from '../muse-usage/store'
import type { Store } from '../persistence'
import type { UsageProviderFacade } from '../usage/usage-provider-facade'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export function startOrcadUsageHistory(
  userDataPath: string,
  store: Pick<Store, 'getRepos' | 'getAllWorktreeMeta'>,
  history: UsageProviderFacade,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): void {
  initClaudeUsagePath(userDataPath)
  initCodexUsagePath(userDataPath)
  initOpenCodeUsagePath(userDataPath)
  initMuseUsagePath(userDataPath)
  const stores = {
    claudeUsage: new ClaudeUsageStore(store),
    codexUsage: new CodexUsageStore(store),
    openCodeUsage: new OpenCodeUsageStore(store),
    museUsage: new MuseUsageStore(store)
  }
  history.setStores(stores)
  registerCleanup(async () => {
    await Promise.all(Object.values(stores).map((source) => source.flush()))
  })
}
