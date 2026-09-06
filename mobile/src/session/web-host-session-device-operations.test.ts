import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionDeviceOperations } from './web-host-session-device-operations'

describe('web host session device operations', () => {
  it('routes shell-owned effects through named native bridge methods', async () => {
    const client = bridgeClient()
    const operations = webHostSessionDeviceOperations(client as unknown as MobileWebBridgeClient)

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
      orderedBuiltInIds: ['escape', 'tab'],
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
    expect(client.navigationRoute).toHaveBeenCalledWith({ destination: 'terminalSettings' })
    expect(client.native.terminalPreferences).toHaveBeenCalledOnce()
    expect(client.native.terminalAccessoryPreferences).toHaveBeenCalledOnce()
    expect(client.native.terminalCustomKeysUpdate).toHaveBeenCalledWith([
      { id: 'custom-1', label: 'Build', bytes: 'pnpm build\r', enter: false }
    ])
    expect(client.native.terminalTextScaleUpdate).toHaveBeenCalledWith(1.5)
  })

  it('keeps nonessential haptic failures out of the interaction path', () => {
    const client = bridgeClient()
    client.native.hapticFeedback.mockRejectedValue(new Error('unavailable'))
    const operations = webHostSessionDeviceOperations(client as unknown as MobileWebBridgeClient)

    expect(() => operations.hapticFeedback('selection')).not.toThrow()
  })
})

function bridgeClient() {
  return {
    navigationRoute: vi.fn().mockResolvedValue(null),
    native: {
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
        orderedBuiltInIds: ['escape', 'tab'],
        visibleBuiltInIds: ['escape']
      }),
      terminalCustomKeysUpdate: vi.fn().mockResolvedValue(null),
      terminalTextScaleUpdate: vi.fn().mockResolvedValue(null)
    }
  }
}
