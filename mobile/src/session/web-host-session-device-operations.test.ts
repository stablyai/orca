import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionDeviceOperations } from './web-host-session-device-operations'
import { getDefaultTerminalAccessoryBuiltInIds } from '../terminal/terminal-accessory-layout'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn().mockResolvedValue(undefined) }
}))

describe('web host session device operations', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null)
  })

  it('applies the paired-host page preference to terminal link behavior', async () => {
    const client = bridgeClient()
    client.native.supports.mockReturnValue(true)
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) =>
      key === 'orca:terminalLinkOpenMode' ? 'orca-browser' : null
    )
    const operations = webHostSessionDeviceOperations(
      client as unknown as MobileWebBridgeClient,
      vi.fn()
    )
    await expect(operations.loadTerminalPreferences()).resolves.toEqual({
      textScale: 1.25,
      autocompleteEnabled: true,
      linkOpenMode: 'orca-browser'
    })
    expect(AsyncStorage.getItem).toHaveBeenCalledWith('orca:terminalLinkOpenMode')
  })

  it('inherits the existing device mode until the host preference is saved', async () => {
    const client = bridgeClient()
    client.native.supports.mockReturnValue(true)
    const operations = webHostSessionDeviceOperations(
      client as unknown as MobileWebBridgeClient,
      vi.fn()
    )
    expect((await operations.loadTerminalPreferences()).linkOpenMode).toBe('phone-browser')
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('temporarily unavailable'))
    await expect(operations.loadTerminalPreferences()).rejects.toThrow('temporarily unavailable')
  })

  it('inherits the native preference until a page value is saved', async () => {
    const client = bridgeClient()
    const operations = webHostSessionDeviceOperations(
      client as unknown as MobileWebBridgeClient,
      vi.fn()
    )
    expect((await operations.loadTerminalPreferences()).linkOpenMode).toBe('phone-browser')
    expect(AsyncStorage.getItem).toHaveBeenCalled()
  })

  it('uses saved scale and autocomplete and stores pinch changes in the same page scope', async () => {
    const client = bridgeClient()
    client.native.supports.mockReturnValue(true)
    vi.mocked(AsyncStorage.getItem).mockImplementation(
      async (key) =>
        ({
          'orca:terminalTextScale': '1.5',
          'orca:terminalAutocompleteEnabled': 'false'
        })[key] ?? null
    )
    const navigate = vi.fn()
    const operations = webHostSessionDeviceOperations(
      client as unknown as MobileWebBridgeClient,
      navigate
    )
    expect(await operations.loadTerminalPreferences()).toEqual({
      textScale: 1.5,
      autocompleteEnabled: false,
      linkOpenMode: 'phone-browser'
    })
    await operations.saveTerminalTextScale(2)
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:terminalTextScale', '2')
    expect(client.native.terminalTextScaleUpdate).not.toHaveBeenCalled()
    operations.openTerminalSettings()
    expect(navigate).toHaveBeenCalledWith('/terminal-settings')
    expect(client.navigationRoute).not.toHaveBeenCalled()
  })

  it('keeps an explicitly empty custom-key list and shares session edits with settings', async () => {
    const client = bridgeClient()
    client.native.supports.mockReturnValue(true)
    const key = { id: 'build', label: 'Build', bytes: 'make', enter: true }
    client.native.terminalAccessoryPreferences.mockResolvedValue({
      customKeys: [key],
      orderedBuiltInIds: ['escape', 'tab'],
      visibleBuiltInIds: []
    })
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (name) =>
      name === 'orca:custom-accessory-keys' ? '[]' : null
    )
    const operations = webHostSessionDeviceOperations(
      client as unknown as MobileWebBridgeClient,
      vi.fn()
    )
    expect((await operations.loadTerminalAccessoryPreferences()).customKeys).toEqual([])
    await operations.saveTerminalCustomKeys([key])
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:custom-accessory-keys',
      JSON.stringify([key])
    )
    expect(client.native.terminalCustomKeysUpdate).not.toHaveBeenCalled()
  })

  it('routes shell-owned effects through named native bridge methods', async () => {
    const client = bridgeClient()
    const operations = webHostSessionDeviceOperations(
      client as unknown as MobileWebBridgeClient,
      vi.fn()
    )

    operations.hapticFeedback('selection')
    await expect(operations.clipboardAvailability()).resolves.toEqual({
      hasText: true,
      hasImage: false
    })
    await expect(operations.copyText('selected text')).resolves.toEqual({
      confirmation: 'in-app'
    })
    await operations.openExternalUrl('https://example.com')
    operations.openTerminalSettings()
    await expect(operations.loadTerminalPreferences()).resolves.toEqual({
      textScale: 1.25,
      autocompleteEnabled: true,
      linkOpenMode: 'phone-browser'
    })
    await expect(operations.loadTerminalAccessoryPreferences()).resolves.toEqual({
      customKeys: [],
      orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
      visibleBuiltInIds: ['escape']
    })
    await operations.saveTerminalCustomKeys([
      { id: 'custom-1', label: 'Build', bytes: 'pnpm build\r', enter: false }
    ])
    await operations.saveTerminalTextScale(1.5)

    expect(client.native.hapticFeedback).toHaveBeenCalledWith('selection')
    expect(client.native.clipboardAvailability).toHaveBeenCalledOnce()
    expect(client.native.clipboardWrite).toHaveBeenCalledWith('selected text')
    expect(client.native.openExternal).toHaveBeenCalledWith('https://example.com')
    expect(client.navigationRoute).not.toHaveBeenCalled()
    expect(client.native.terminalPreferences).toHaveBeenCalledOnce()
    expect(client.native.terminalAccessoryPreferences).toHaveBeenCalledOnce()
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'orca:custom-accessory-keys',
      JSON.stringify([{ id: 'custom-1', label: 'Build', bytes: 'pnpm build\r', enter: false }])
    )
    expect(AsyncStorage.setItem).toHaveBeenCalledWith('orca:terminalTextScale', '1.5')
  })

  it('keeps nonessential haptic failures out of the interaction path', () => {
    const client = bridgeClient()
    client.native.hapticFeedback.mockRejectedValue(new Error('unavailable'))
    const operations = webHostSessionDeviceOperations(
      client as unknown as MobileWebBridgeClient,
      vi.fn()
    )

    expect(() => operations.hapticFeedback('selection')).not.toThrow()
  })
})

function bridgeClient() {
  return {
    navigationRoute: vi.fn().mockResolvedValue(null),
    native: {
      supports: vi.fn().mockReturnValue(false),
      hapticFeedback: vi.fn().mockResolvedValue(null),
      clipboardAvailability: vi.fn().mockResolvedValue({ hasText: true, hasImage: false }),
      clipboardWrite: vi.fn().mockResolvedValue({ confirmation: 'in-app' }),
      openExternal: vi.fn().mockResolvedValue(null),
      terminalPreferences: vi.fn().mockResolvedValue({
        textScale: 1.25,
        autocompleteEnabled: true,
        linkOpenMode: 'phone-browser'
      }),
      terminalAccessoryPreferences: vi.fn().mockResolvedValue({
        customKeys: [],
        orderedBuiltInIds: getDefaultTerminalAccessoryBuiltInIds(),
        visibleBuiltInIds: ['escape']
      }),
      terminalCustomKeysUpdate: vi.fn().mockResolvedValue(null),
      terminalTextScaleUpdate: vi.fn().mockResolvedValue(null)
    }
  }
}
