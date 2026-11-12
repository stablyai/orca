import type { UsageStoreHost, UsageWorktreeCatalog } from './usage-store-host'
import type { UsageAccountRoot } from './usage-account-attribution'

export function createTestUsageStoreHost(options: {
  userDataPath: string
  catalog?: UsageWorktreeCatalog
  profileDirs?: string[]
  accountRoots?: Partial<Record<'claude' | 'opencode', UsageAccountRoot[]>>
  telemetryEnabled?: boolean
  capture?: UsageStoreHost['telemetry']['capture']
  signal?: AbortSignal
}): UsageStoreHost {
  return {
    userDataPath: options.userDataPath,
    signal: options.signal ?? new AbortController().signal,
    readCatalog: async () => options.catalog ?? { repoIds: [], worktreesByRepo: [] },
    claudeProfileDirs: async () => options.profileDirs ?? [],
    accountRoots: async (provider) => options.accountRoots?.[provider] ?? [],
    telemetry: {
      isEnabled: async () => options.telemetryEnabled ?? false,
      capture: options.capture ?? (async () => true)
    }
  }
}
