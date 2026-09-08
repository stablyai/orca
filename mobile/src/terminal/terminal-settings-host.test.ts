import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeTerminalSettingsHost } from './native-terminal-settings-host'
import {
  webTerminalSettingsHost,
  webTerminalSettingsOperations
} from './web-terminal-settings-operations'
import hostedPageStorage from '../mobile-web/hosted-page-async-storage'
import { setMobileWebPagePreferencesClient } from '../../../src/mobile-web/src/mobile-web-page-preferences-channel'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) }
}))
afterEach(() => setMobileWebPagePreferencesClient(null))

describe('terminal restore settings adapters', () => {
  it('loads all settings sections within the page preference concurrency grant', async () => {
    // The page bundle resolves async storage to the hosted bridge adapter.
    vi.mocked(AsyncStorage.getItem).mockImplementation((key: string) =>
      hostedPageStorage.getItem(key)
    )
    let inFlight = 0
    const pagePreferences = vi.fn(async (payload: { keys?: string[] }) => {
      if (++inFlight > 4) {
        inFlight--
        throw new Error('page preference concurrency exhausted')
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return { entries: (payload.keys ?? []).map((key) => [key, null]) }
    })
    setMobileWebPagePreferencesClient({
      native: { pagePreferences }
    } as unknown as MobileWebBridgeClient)
    const client = {
      native: {
        terminalPreferences: async () => ({
          textScale: 1,
          autocompleteEnabled: false,
          linkOpenMode: 'orca-browser'
        }),
        terminalAccessoryPreferences: async () => ({
          customKeys: [],
          orderedBuiltInIds: ['escape'],
          visibleBuiltInIds: []
        })
      }
    }
    const settings = webTerminalSettingsOperations(client as unknown as MobileWebBridgeClient)
    try {
      await expect(
        Promise.all([settings.loadPreferences(), settings.loadKeys(), settings.loadLayout()])
      ).resolves.toHaveLength(3)
      expect(pagePreferences.mock.calls.length).toBeLessThan(4)
    } finally {
      vi.mocked(AsyncStorage.getItem).mockImplementation(async () => null)
    }
  })

  it('unwraps the actual native RPC result and surfaces refusal', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ ok: true, result: { ms: 60000 } })
    const host = nativeTerminalSettingsHost({ id: 'host', name: 'Desktop' }, {
      sendRequest
    } as unknown as RpcClient)
    expect(await host.loadFit()).toBe(60000)
    sendRequest.mockResolvedValue({ ok: true, result: { ms: null } })
    expect(await host.saveFit(null)).toBe(null)
    sendRequest.mockResolvedValue({ ok: false, error: { message: 'denied' } })
    await expect(host.saveFit(60000)).rejects.toThrow('denied')
    expect(sendRequest).toHaveBeenLastCalledWith('terminal.setAutoRestoreFit', { ms: 60000 })
  })
  it('reaches both host methods and sends no invented workspace', async () => {
    const client = fixture()
    const host = webTerminalSettingsHost(client as unknown as MobileWebBridgeClient)
    expect(await host.loadFit()).toBe(60000)
    expect(client.host.request).toHaveBeenCalledWith({
      method: 'terminal.getAutoRestoreFit',
      params: {}
    })
    await host.saveFit(null)
    expect(client.host.request).toHaveBeenLastCalledWith({
      method: 'terminal.setAutoRestoreFit',
      params: { ms: null }
    })
  })
  it('does not retry an ambiguous host mutation', async () => {
    const client = fixture()
    const host = webTerminalSettingsHost(client as unknown as MobileWebBridgeClient)
    client.host.request.mockRejectedValue(new Error('connection lost'))
    await expect(host.saveFit(60000)).rejects.toThrow('connection lost')
    expect(client.host.request).toHaveBeenCalledTimes(1)
  })
})
function fixture() {
  return {
    host: { request: vi.fn().mockResolvedValue({ ms: 60000 }) }
  }
}
