import { join } from 'node:path'
import { createUsageService } from '../backend/usage-service'
import {
  claudeProfileTranscriptDirs,
  claudeProfileTranscriptSources
} from '../claude-usage/transcript-file-discovery'
import { UsageWorktreeHistory } from '../usage/worktree-attribution/usage-worktree-history'
import { loadKnownUsageWorktreesByRepo } from '../usage/worktree-attribution/usage-worktree-metadata'
import { openCodeUsageAccountRoots } from '../opencode-usage/opencode-usage-account-roots'
import type { UsageProviderFacade } from '../usage/usage-provider-facade'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export function startOrcadUsageHistory(
  userDataPath: string,
  store: ConstructorParameters<typeof UsageWorktreeHistory>[0],
  history: UsageProviderFacade,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): void {
  const worktrees = new UsageWorktreeHistory(
    store,
    join(userDataPath, 'orca-usage-worktree-history.json')
  )
  const abort = new AbortController()
  const service = createUsageService({
    signal: abort.signal,
    userDataPath,
    readCatalog: async () => {
      await worktrees.whenLoaded()
      const repos = worktrees.getRepos()
      return {
        repoIds: repos.map((repo) => repo.id),
        worktreesByRepo: [...loadKnownUsageWorktreesByRepo(worktrees, repos)]
      }
    },
    claudeProfileDirs: async () => claudeProfileTranscriptDirs(),
    accountRoots: async (provider) =>
      provider === 'claude' ? claudeProfileTranscriptSources() : openCodeUsageAccountRoots(),
    telemetry: { isEnabled: async () => false, capture: async () => false }
  })
  history.setInvoker((method, params) => service.invoke(method, params, false))
  registerCleanup(async () => {
    abort.abort()
    try {
      await service.stop()
    } finally {
      await worktrees.flush()
    }
  })
}
