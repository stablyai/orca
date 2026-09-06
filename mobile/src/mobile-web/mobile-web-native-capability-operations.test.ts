import { describe, expect, it, vi } from 'vitest'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import { executeMobileWebNativeCapabilityOperation } from './mobile-web-native-capability-operations'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web native capability operations', () => {
  it('reads bounded shell-owned terminal preferences', async () => {
    const harness = createHarness()

    await expect(
      executeMobileWebNativeCapabilityOperation({
        operation: 'terminalPreferences',
        payload: {},
        authority: harness.authority
      })
    ).resolves.toEqual({
      textScale: 1.25,
      autocompleteEnabled: true,
      linkOpenMode: 'phone-browser'
    })
  })

  it('reads and updates bounded shell-owned terminal shortcuts', async () => {
    const harness = createHarness()
    const customKeys = [{ id: 'custom-1', label: 'Build', bytes: 'pnpm build\r', enter: false }]

    await expect(
      executeMobileWebNativeCapabilityOperation({
        operation: 'terminalAccessoryPreferences',
        payload: {},
        authority: harness.authority
      })
    ).resolves.toEqual({
      customKeys,
      orderedBuiltInIds: ['escape', 'tab'],
      visibleBuiltInIds: ['escape']
    })

    await expect(
      executeMobileWebNativeCapabilityOperation({
        operation: 'terminalCustomKeysUpdate',
        payload: { customKeys },
        authority: harness.authority
      })
    ).resolves.toBeNull()
    expect(harness.terminalCustomKeysUpdate).toHaveBeenCalledWith(customKeys)
  })

  it('probes clipboard types without reading content', async () => {
    const harness = createHarness()

    await expect(
      executeMobileWebNativeCapabilityOperation({
        operation: 'clipboardAvailability',
        payload: {},
        authority: harness.authority
      })
    ).resolves.toEqual({ hasText: true, hasImage: false })
    expect(harness.clipboardAvailability).toHaveBeenCalledOnce()
  })

  it('writes only the bounded text the clipboard payload carries', async () => {
    const harness = createHarness()

    await expect(
      executeMobileWebNativeCapabilityOperation({
        operation: 'clipboardWrite',
        payload: { text: 'selected text' },
        authority: harness.authority
      })
    ).resolves.toEqual({ confirmation: 'in-app' })
    expect(harness.clipboardWrite).toHaveBeenCalledWith('selected text')
  })

  it('allows only validated web URLs, and bounded text-scale updates', async () => {
    const harness = createHarness()

    await expect(
      executeMobileWebNativeCapabilityOperation({
        operation: 'openExternal',
        payload: { url: 'javascript:alert(1)' },
        authority: harness.authority
      })
    ).rejects.toThrow()
    expect(harness.openExternal).not.toHaveBeenCalled()

    await executeMobileWebNativeCapabilityOperation({
      operation: 'openExternal',
      payload: { url: 'https://example.com/path' },
      authority: harness.authority
    })
    await executeMobileWebNativeCapabilityOperation({
      operation: 'terminalTextScaleUpdate',
      payload: { textScale: 1.5 },
      authority: harness.authority
    })

    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/path')
    expect(harness.terminalTextScaleUpdate).toHaveBeenCalledWith(1.5)
  })

  it('runs bounded haptics through the shell authority', async () => {
    const harness = createHarness()

    await executeMobileWebNativeCapabilityOperation({
      operation: 'hapticFeedback',
      payload: { kind: 'edge-bump' },
      authority: harness.authority
    })

    expect(harness.hapticFeedback).toHaveBeenCalledWith('edge-bump')
  })

  it('resolves opaque workspace authority before reading or writing a shell draft', async () => {
    const harness = createHarness()
    const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
    const browserAuthority = new MobileWebBrowserAuthority((length) => new Uint8Array(length))
    const workspaceId = workspaceAuthority.registerWorkspace('host-workspace', 'host-repo')
    const sessionChatDraftRead = vi.fn().mockResolvedValue('saved draft')
    const sessionChatDraftWrite = vi.fn().mockResolvedValue(undefined)
    harness.authority.sessionChatDraftRead = sessionChatDraftRead
    harness.authority.sessionChatDraftWrite = sessionChatDraftWrite

    await expect(
      executeMobileWebNativeCapabilityOperation({
        operation: 'sessionChatDraftRead',
        payload: { workspaceId, tabId: 'host-tab' },
        authority: harness.authority,
        browserAuthority,
        workspaceAuthority
      })
    ).resolves.toEqual({ text: 'saved draft' })
    await expect(
      executeMobileWebNativeCapabilityOperation({
        operation: 'sessionChatDraftWrite',
        payload: { workspaceId, tabId: 'host-tab', text: 'next draft' },
        authority: harness.authority,
        browserAuthority,
        workspaceAuthority
      })
    ).resolves.toBeNull()

    expect(sessionChatDraftRead).toHaveBeenCalledWith('host-workspace', 'host-tab')
    expect(sessionChatDraftWrite).toHaveBeenCalledWith('host-workspace', 'host-tab', 'next draft')
  })
})

function createHarness() {
  const hapticFeedback = vi.fn()
  const clipboardAvailability = vi.fn().mockResolvedValue({ hasText: true, hasImage: false })
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
  const authority: MobileWebNativeCapabilityAuthority = {
    hapticFeedback,
    clipboardAvailability,
    clipboardWrite,
    openExternal,
    terminalAccessoryPreferences,
    terminalCustomKeysUpdate,
    terminalPreferences,
    terminalTextScaleUpdate
  }
  return {
    authority,
    clipboardAvailability,
    clipboardWrite,
    hapticFeedback,
    openExternal,
    terminalCustomKeysUpdate,
    terminalTextScaleUpdate
  }
}
