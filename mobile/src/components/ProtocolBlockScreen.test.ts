import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownAppUpdate } from '../storage/app-update-preferences'
import type { BlockedVerdict } from './ProtocolBlockScreen'
import { ProtocolBlockScreen } from './ProtocolBlockScreen'

const nativeTestState = vi.hoisted(() => {
  // Declared wide so a test can switch stores; an assertion here would only widen the same literal.
  const platform: { OS: 'ios' | 'android' } = { OS: 'ios' }
  return { openUrl: vi.fn(), platform }
})

const wallUpdate = vi.hoisted(() => {
  const state: { current: KnownAppUpdate | null } = { current: null }
  return state
})

// The release the installed app's update check found; the real hook imports the checker module.
vi.mock('../app-update/use-wall-app-update', () => ({
  isGooglePlayInstall: false,
  useWallAppUpdate: () => wallUpdate.current
}))

vi.mock('react-native', () => ({
  Linking: { openURL: nativeTestState.openUrl },
  Platform: nativeTestState.platform,
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('expo-router', () => ({
  router: { replace: vi.fn() },
  // Mock native handoff’s router hook; web sibling posts target to shell.
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), dismissTo: vi.fn() })
}))

const RELEASES_URL = 'https://github.com/stablyai/orca/releases'

let renderer: ReactTestRenderer | null = null

function render(verdict: BlockedVerdict, mobileUpdate: KnownAppUpdate | null = null): void {
  wallUpdate.current = mobileUpdate
  act(() => {
    renderer = create(createElement(ProtocolBlockScreen, { verdict }))
  })
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

  it('sends a host without a bundle to the desktop release', () => {
    render({ kind: 'blocked', reason: 'bundle-unavailable' })
    expect(primaryActionUrl()).toBe(RELEASES_URL)
  })

  it('sends an unknown manifest schema to the mobile update', () => {
    render({
      kind: 'blocked',
      reason: 'bundle-shell-too-old',
      schemaVersion: 2
    })
    expect(primaryActionUrl()).toBe('itms-apps://apps.apple.com/app/orca-ide/id6766130217')
  })

  it('offers no download for a cached bundle the host outgrew, because none would clear it', () => {
    render({
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'mobile',
      bundleRuntimeProtocolVersion: 3,
      requiredBundleRuntimeProtocolVersion: 4
    })

    // Back to hosts is the only button left, and it is not a download.
    expect(pressableCount()).toBe(1)
  })

  it('sends a host older than its own bundle to the desktop update', () => {
    render({
      kind: 'blocked',
      reason: 'bundle-incompatible',
      side: 'desktop',
      hostProtocolVersion: 1,
      requiredHostProtocolVersion: 2
    })
    expect(primaryActionUrl()).toBe(RELEASES_URL)
  })

  describe('with the newest release known', () => {
    const release = {
      version: '0.0.52',
      url: 'https://github.com/stablyai/orca/releases/tag/mobile-v0.0.52'
    }

    it('opens the known Android release', () => {
      nativeTestState.platform.OS = 'android'
      render({ kind: 'blocked', reason: 'bundle-shell-too-old', schemaVersion: 2 }, release)
      expect(primaryActionUrl()).toBe(release.url)
    })

    it('leaves the desktop wall on the desktop releases', () => {
      render({ kind: 'blocked', reason: 'bundle-unavailable' }, release)
      expect(primaryActionUrl()).toBe(RELEASES_URL)
    })
  })

  it.each([
    ['ios', 'itms-apps://apps.apple.com/app/orca-ide/id6766130217'],
    ['android', RELEASES_URL]
  ] as const)('keeps the %s store link when no release is known', (os, url) => {
    nativeTestState.platform.OS = os
    render(
      { kind: 'blocked', reason: 'mobile-too-old', desktopVersion: 5, requiredMobileVersion: 9 },
      null
    )
    expect(primaryActionUrl()).toBe(url)
  })
})
