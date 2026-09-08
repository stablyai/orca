import { describe, expect, it, vi } from 'vitest'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_NATIVE_GRANTS } from './mobile-web-production-native-grants'

describe('mobile web native capability round trip', () => {
  it('keeps device effects in the shell behind typed grants', async () => {
    const alert = vi.fn().mockResolvedValue({ kind: 'button' as const, buttonIndex: 1 })
    const hapticFeedback = vi.fn()
    const clipboardWrite = vi.fn().mockResolvedValue({ confirmation: 'in-app' as const })
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const terminalPreferences = vi.fn().mockResolvedValue({
      textScale: 1.25 as const,
      autocompleteEnabled: true,
      linkOpenMode: 'phone-browser' as const
    })
    const terminalAccessoryPreferences = vi.fn().mockResolvedValue({
      customKeys: [{ id: 'custom-1', label: 'Build', bytes: 'pnpm build\r', enter: false }],
      orderedBuiltInIds: ['escape', 'tab'],
      visibleBuiltInIds: ['escape']
    })
    const terminalCustomKeysUpdate = vi.fn().mockResolvedValue(undefined)
    const terminalTextScaleUpdate = vi.fn().mockResolvedValue(undefined)
    let requestIndex = 0
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_NATIVE_GRANTS],
      createRequestId: () => String.fromCharCode(65 + requestIndex++).repeat(22),
      isConnected: () => false,
      nativeAuthority: {
        alert,
        hapticFeedback,
        clipboardWrite,
        openExternal,
        terminalAccessoryPreferences,
        terminalCustomKeysUpdate,
        terminalPreferences,
        terminalTextScaleUpdate
      },
      navigationAuthority: {
        route: vi.fn(),
        reconnect: vi.fn(),
        removeHost: vi.fn()
      }
    })

    await expect(
      client.native.alert({
        title: 'Discard changes?',
        message: 'Unsaved edits will be lost.',
        buttons: [
          { text: 'Stay', style: 'cancel' },
          { text: 'Discard', style: 'destructive' }
        ],
        options: { cancelable: false }
      })
    ).resolves.toEqual({ kind: 'button', buttonIndex: 1 })
    await expect(client.native.terminalPreferences()).resolves.toEqual({
      textScale: 1.25,
      autocompleteEnabled: true,
      linkOpenMode: 'phone-browser'
    })
    await expect(client.native.terminalAccessoryPreferences()).resolves.toEqual({
      customKeys: [{ id: 'custom-1', label: 'Build', bytes: 'pnpm build\r', enter: false }],
      orderedBuiltInIds: ['escape', 'tab'],
      visibleBuiltInIds: ['escape']
    })
    await expect(client.native.hapticFeedback('selection')).resolves.toBeNull()
    await expect(client.native.clipboardWrite('selected text')).resolves.toEqual({
      confirmation: 'in-app'
    })
    await expect(client.native.openExternal('javascript:alert(1)')).rejects.toThrow()
    await expect(client.native.openExternal('https://example.com')).resolves.toBeNull()
    await expect(client.native.terminalTextScaleUpdate(1.5)).resolves.toBeNull()
    await expect(
      client.native.terminalCustomKeysUpdate([
        { id: 'custom-2', label: 'Test', bytes: 'pnpm test\r', enter: false }
      ])
    ).resolves.toBeNull()

    expect(hapticFeedback).toHaveBeenCalledWith('selection')
    expect(alert).toHaveBeenCalledWith({
      title: 'Discard changes?',
      message: 'Unsaved edits will be lost.',
      buttons: [
        { text: 'Stay', style: 'cancel' },
        { text: 'Discard', style: 'destructive' }
      ],
      options: { cancelable: false }
    })
    expect(clipboardWrite).toHaveBeenCalledWith('selected text')
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
    expect(openExternal).not.toHaveBeenCalledWith('javascript:alert(1)')
    expect(terminalTextScaleUpdate).toHaveBeenCalledWith(1.5)
    expect(terminalCustomKeysUpdate).toHaveBeenCalledWith([
      { id: 'custom-2', label: 'Test', bytes: 'pnpm test\r', enter: false }
    ])
  })
})
