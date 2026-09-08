import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import {
  nativeTerminalSettingsOperations,
  type TerminalSettingsHost,
  type TerminalSettingsOperations
} from './terminal-settings-operations'
import {
  loadWebHostTerminalAccessoryPreferences,
  loadWebHostTerminalPreferences
} from './web-terminal-preferences'

export function webTerminalSettingsOperations(
  client: MobileWebBridgeClient
): TerminalSettingsOperations {
  return {
    ...nativeTerminalSettingsOperations,
    loadPreferences: () => loadWebHostTerminalPreferences(client),
    loadKeys: async () => (await loadWebHostTerminalAccessoryPreferences(client)).customKeys,
    loadLayout: () => loadWebHostTerminalAccessoryPreferences(client)
  }
}
const fitMethods = ['terminal.getAutoRestoreFit', 'terminal.setAutoRestoreFit']
// The desktop socket gate decides whether these reach a handler; a refusal surfaces on the call.
export function webTerminalSettingsHost(client: MobileWebBridgeClient): TerminalSettingsHost {
  async function request(method: string, params: Record<string, unknown> = {}) {
    const result = (await client.host.request({ method, params })) as { ms?: unknown } | null
    if (result?.ms !== null && (typeof result?.ms !== 'number' || !Number.isFinite(result.ms))) {
      throw new Error('Invalid terminal restore preference')
    }
    return result.ms as number | null
  }
  return {
    id: 'paired-host',
    name: 'Paired desktop',
    loadFit: () => request(fitMethods[0]!),
    saveFit: (ms) => request(fitMethods[1]!, { ms })
  }
}
