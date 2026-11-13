import type {
  BackendConnectionListener,
  BackendConnectionPurpose
} from '../shared/backend-service-contract'
import type { PreloadApi } from './api-types'

type UsageProviderApiKey = 'claudeUsage' | 'codexUsage' | 'openCodeUsage' | 'museUsage'
type UsageProviderApi = PreloadApi[UsageProviderApiKey]
type UsageRangeArgs = { scope: string; range: string }

export function createUsageProviderApi<Key extends UsageProviderApiKey>(
  ipc: {
    invoke(channel: string, args?: unknown, purpose?: BackendConnectionPurpose): Promise<unknown>
    onConnectionChanged?: (listener: BackendConnectionListener) => () => void
  },
  prefix: Key
): PreloadApi[Key]
export function createUsageProviderApi(
  ipc: {
    invoke(channel: string, args?: unknown, purpose?: BackendConnectionPurpose): Promise<unknown>
    onConnectionChanged?: (listener: BackendConnectionListener) => () => void
  },
  prefix: UsageProviderApiKey
): UsageProviderApi {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The prefix selects its typed service methods; only the transport boundary erases their return types.
  return {
    ...(ipc.onConnectionChanged ? { onConnectionChanged: ipc.onConnectionChanged } : {}),
    getScanState: (purpose?: BackendConnectionPurpose) =>
      purpose
        ? ipc.invoke(`${prefix}:getScanState`, undefined, purpose)
        : ipc.invoke(`${prefix}:getScanState`),
    setEnabled: (args: { enabled: boolean }) => ipc.invoke(`${prefix}:setEnabled`, args),
    refresh: (args?: { force?: boolean }) => ipc.invoke(`${prefix}:refresh`, args),
    getSnapshot: (args: UsageRangeArgs & { limit?: number }, purpose?: BackendConnectionPurpose) =>
      purpose
        ? ipc.invoke(`${prefix}:getSnapshot`, args, purpose)
        : ipc.invoke(`${prefix}:getSnapshot`, args),
    getSummary: (args: UsageRangeArgs) => ipc.invoke(`${prefix}:getSummary`, args),
    getDaily: (args: UsageRangeArgs) => ipc.invoke(`${prefix}:getDaily`, args),
    getBreakdown: (args: UsageRangeArgs & { kind: string }) =>
      ipc.invoke(`${prefix}:getBreakdown`, args),
    getRecentSessions: (args: UsageRangeArgs & { limit?: number }) =>
      ipc.invoke(`${prefix}:getRecentSessions`, args)
  } as UsageProviderApi
}
