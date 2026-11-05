import type { IpcRenderer } from 'electron'
import type {
  ClaudeUsageProviderApi,
  CodexUsageApi,
  MuseUsageApi,
  OpenCodeUsageApi
} from './api/agent-usage-api'

// Provider-specific extras (Claude's getStatsCache) are added by each bridge.
type UsageProviderApiByKey = {
  claudeUsage: ClaudeUsageProviderApi
  codexUsage: CodexUsageApi
  openCodeUsage: OpenCodeUsageApi
  museUsage: MuseUsageApi
}
type UsageProviderApiKey = keyof UsageProviderApiByKey
type UsageProviderApi = UsageProviderApiByKey[UsageProviderApiKey]
type UsageRangeArgs = { scope: string; range: string }

export function createUsageProviderApi<Key extends UsageProviderApiKey>(
  ipc: Pick<IpcRenderer, 'invoke'>,
  prefix: Key
): UsageProviderApiByKey[Key]
export function createUsageProviderApi(
  ipc: Pick<IpcRenderer, 'invoke'>,
  prefix: UsageProviderApiKey
): UsageProviderApi {
  return {
    getScanState: () => ipc.invoke(`${prefix}:getScanState`),
    setEnabled: (args: { enabled: boolean }) => ipc.invoke(`${prefix}:setEnabled`, args),
    refresh: (args?: { force?: boolean }) => ipc.invoke(`${prefix}:refresh`, args),
    getSnapshot: (args: UsageRangeArgs & { limit?: number }) =>
      ipc.invoke(`${prefix}:getSnapshot`, args),
    getSummary: (args: UsageRangeArgs) => ipc.invoke(`${prefix}:getSummary`, args),
    getDaily: (args: UsageRangeArgs) => ipc.invoke(`${prefix}:getDaily`, args),
    getBreakdown: (args: UsageRangeArgs & { kind: string }) =>
      ipc.invoke(`${prefix}:getBreakdown`, args),
    getRecentSessions: (args: UsageRangeArgs & { limit?: number }) =>
      ipc.invoke(`${prefix}:getRecentSessions`, args)
  }
}
