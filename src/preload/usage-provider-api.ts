import type { IpcRenderer } from 'electron'
import type { PreloadApi } from './api-types'

type UsageProviderApiKey = 'claudeUsage' | 'codexUsage' | 'openCodeUsage'
type UsageProviderApi = PreloadApi[UsageProviderApiKey]
type UsageRangeArgs = { scope: string; range: string }

export function createUsageProviderApi<Key extends UsageProviderApiKey>(
  ipc: Pick<IpcRenderer, 'invoke'>,
  prefix: Key
): PreloadApi[Key]
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
