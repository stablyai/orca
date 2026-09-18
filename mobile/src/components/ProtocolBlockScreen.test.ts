import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockedVerdict } from './ProtocolBlockScreen'
import { ProtocolBlockScreen } from './ProtocolBlockScreen'

const nativeTestState = vi.hoisted(() => {
  // Declared wide so a test can switch stores; an assertion here would only widen the same literal.
  const platform: { OS: 'ios' | 'android' } = { OS: 'ios' }
  return { openUrl: vi.fn(), platform }
})

vi.mock('react-native', () => ({
  Linking: { openURL: nativeTestState.openUrl },
  Platform: nativeTestState.platform,
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('expo-router', () => ({
  router: { replace: vi.fn() }
}))

const RELEASES_URL = 'https://github.com/stablyai/orca/releases'

let renderer: ReactTestRenderer | null = null

function render(verdict: BlockedVerdict): string {
  act(() => {
    renderer = create(createElement(ProtocolBlockScreen, { verdict }))
  })
  return JSON.stringify(renderer?.toJSON())
}

/** The mocked host components are plain strings, which `ElementType` does not admit. */
function isMockedHostElement(type: unknown, name: string): boolean {
  return type === name
}

function pressableCount(): number {
  return renderer?.root.findAll((node) => isMockedHostElement(node.type, 'Pressable')).length ?? 0
}

function primaryActionUrl(): unknown {
  const pressable = renderer?.root.findAll((node) => isMockedHostElement(node.type, 'Pressable'))[0]
  act(() => pressable?.props.onPress())
  return nativeTestState.openUrl.mock.calls[0]?.[0]
}

describe('ProtocolBlockScreen', () => {
  beforeEach(() => {
    nativeTestState.openUrl.mockClear()
    nativeTestState.platform.OS = 'ios'
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  // Why: the protocol wall shipped before the bundle one; its copy is what users already see.
  it('keeps the existing protocol wall rendering unchanged', () => {
    const mobile = render({
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion: 5,
      requiredMobileVersion: 99
    })
    expect(mobile).toContain('Update Orca Mobile')
    expect(mobile).toContain(
      'This desktop needs a newer Orca Mobile app. Update Orca Mobile from the App Store, then try this host again.'
    )
    expect(mobile).toContain('Open App Store')
    act(() => renderer?.unmount())

    const desktop = render({
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion: 0,
      requiredDesktopVersion: 2
    })
    expect(desktop).toContain('Update Orca on your computer')
    expect(desktop).toContain(
      'This paired desktop app is too old for your current Orca Mobile app. Update Orca on your computer, then try this host again.'
    )
    expect(desktop).toContain('Open GitHub Releases')
  })

  it('sends a host without a bundle to the desktop update', () => {
    const output = render({ kind: 'blocked', reason: 'bundle-unavailable' })
    expect(output).toContain('Update Orca on your computer')
    expect(output).toContain(
      'This paired desktop app does not include the mobile workspace yet. Update Orca on your computer, then try this host again.'
    )
    expect(primaryActionUrl()).toBe(RELEASES_URL)
  })

  it('sends an unknown manifest schema to the mobile update', () => {
    const output = render({
      kind: 'blocked',
      reason: 'bundle-shell-too-old',
      schemaVersion: 2
    })
    expect(output).toContain('Update Orca Mobile')
    expect(output).toContain(
      "This desktop's mobile workspace needs a newer Orca Mobile app. Update Orca Mobile from the App Store, then try this host again."
    )
    expect(primaryActionUrl()).toBe('itms-apps://apps.apple.com/app/orca-ide/id6766130217')
  })

  it('offers no download for a cached bundle the host outgrew, because none would clear it', () => {
    const output = render({
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'mobile',
      bundleRuntimeProtocolVersion: 3,
      requiredBundleRuntimeProtocolVersion: 4
    })

    expect(output).toContain('Refresh the mobile workspace')
    expect(output).toContain(
      'The workspace cached for this host is older than the desktop expects. Reconnect to this host to download the current one.'
    )
    // A store update cannot replace a stale cache, so neither store link is offered.
    expect(output).not.toContain('Open App Store')
    expect(output).not.toContain('Open GitHub Releases')
    expect(output).not.toContain('Update Orca')
    // Back to hosts is the only button left, and it is not a download.
    expect(pressableCount()).toBe(1)
    expect(output).toContain('Back to hosts')
    // Nothing was "already updated" here; the note keeps only the pairing fallback.
    expect(output).not.toContain('Already updated?')
    expect(output).toContain('If this message stays, remove this host and pair it again.')
  })

  it('sends a host older than its own bundle to the desktop update', () => {
    const output = render({
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'desktop',
      hostProtocolVersion: 1,
      requiredHostProtocolVersion: 2
    })
    expect(output).toContain('Update Orca on your computer')
    expect(output).toContain('This paired desktop app is too old for your current Orca Mobile app')
    expect(primaryActionUrl()).toBe(RELEASES_URL)
  })

  it('routes an Android bundle wall to GitHub Releases, not a store that has no listing', () => {
    nativeTestState.platform.OS = 'android'
    const output = render({
      kind: 'blocked',
      reason: 'bundle-shell-too-old',
      schemaVersion: 2
    })
    expect(output).toContain('Update Orca Mobile from GitHub Releases')
    expect(primaryActionUrl()).toBe(RELEASES_URL)
  })

  it('keeps the update walls on two buttons and the full recovery note', () => {
    const output = render({ kind: 'blocked', reason: 'bundle-unavailable' })
    expect(output).toContain('Already updated? Go back to Hosts and refresh the connection.')
    // The presence precondition for the absence asserted on the refresh wall above.
    expect(pressableCount()).toBe(2)
  })
})
