import { join } from 'node:path'
import { ClaudeUsageStore, initClaudeUsagePath } from '../claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from '../codex-usage/store'
import { OpenCodeUsageStore, initOpenCodeUsagePath } from '../opencode-usage/store'
import { MuseUsageStore, initMuseUsagePath } from '../muse-usage/store'
import { UsageWorktreeHistory } from '../usage/worktree-attribution/usage-worktree-history'
import type { UsageProviderFacade } from '../usage/usage-provider-facade'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export function startOrcadUsageHistory(
  userDataPath: string,
  store: ConstructorParameters<typeof UsageWorktreeHistory>[0],
  history: UsageProviderFacade,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): void {
  initClaudeUsagePath(userDataPath)
  initCodexUsagePath(userDataPath)
  initOpenCodeUsagePath(userDataPath)
  initMuseUsagePath(userDataPath)
  const worktrees = new UsageWorktreeHistory(
    store,
    join(userDataPath, 'orca-usage-worktree-history.json')
  )
  const stores = {
    claudeUsage: new ClaudeUsageStore(worktrees),
    codexUsage: new CodexUsageStore(worktrees),
    openCodeUsage: new OpenCodeUsageStore(worktrees),
    museUsage: new MuseUsageStore(worktrees)
  }
  history.setStores(stores)
  registerCleanup(async () => {
    await Promise.all([worktrees.flush(), ...Object.values(stores).map((source) => source.flush())])
  })
}
