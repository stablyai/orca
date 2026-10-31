import { ClaudeUsageStore, initClaudeUsagePath } from '../claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from '../codex-usage/store'
import { MuseUsageStore, initMuseUsagePath } from '../muse-usage/store'
import { OpenCodeUsageStore, initOpenCodeUsagePath } from '../opencode-usage/store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/** A paired desktop's Settings → Stats & Usage reads these; without them `usage.*` refuses. */
export function startOrcadUsageAnalytics(
  runtime: OrcaRuntimeService,
  userDataPath: string,
  store: Store,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): void {
  initClaudeUsagePath(userDataPath)
  initCodexUsagePath(userDataPath)
  initOpenCodeUsagePath(userDataPath)
  initMuseUsagePath(userDataPath)
  const stores = {
    claude: new ClaudeUsageStore(store),
    codex: new CodexUsageStore(store),
    opencode: new OpenCodeUsageStore(store),
    muse: new MuseUsageStore(store)
  }
  // Why: like the desktop's quit, queued cache writes land before the profile lock is released.
  registerCleanup(async () => {
    await Promise.all(Object.values(stores).map((usage) => usage.flush()))
  })
  runtime.setUsageAnalyticsStores(stores)
}
