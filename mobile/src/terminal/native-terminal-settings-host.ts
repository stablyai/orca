import type { RpcClient } from '../transport/rpc-client'
import type { TerminalSettingsHost } from './terminal-settings-operations'

export function nativeTerminalSettingsHost(
  host: { id: string; name: string },
  client: RpcClient | null
): TerminalSettingsHost {
  async function request(method: string, params?: unknown): Promise<number | null> {
    if (!client) {
      throw new Error('Host is disconnected')
    }
    const response = await client.sendRequest(method, params)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    const result = response.result as { ms?: unknown } | null
    if (result?.ms !== null && (typeof result?.ms !== 'number' || !Number.isFinite(result.ms))) {
      throw new Error('Invalid terminal restore preference')
    }
    return result.ms as number | null
  }
  return {
    id: host.id,
    name: host.name,
    loadFit: () => request('terminal.getAutoRestoreFit'),
    saveFit: (ms) => request('terminal.setAutoRestoreFit', { ms })
  }
}
