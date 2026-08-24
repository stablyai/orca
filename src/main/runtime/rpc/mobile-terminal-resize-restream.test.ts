import { describe, expect, it } from 'vitest'
import {
  resolveTerminalScreenKind,
  shouldRestreamMobileResizeScrollback
} from './mobile-terminal-resize-restream'

describe('shouldRestreamMobileResizeScrollback', () => {
  it('restreams only a known normal-buffer apply-layout', () => {
    expect(shouldRestreamMobileResizeScrollback({ reason: 'apply-layout', screen: 'normal' })).toBe(
      true
    )
  })

  it('skips restream for an alternate-screen TUI', () => {
    expect(
      shouldRestreamMobileResizeScrollback({ reason: 'apply-layout', screen: 'alternate' })
    ).toBe(false)
  })

  it('skips restream when provider state cannot prove the screen', () => {
    expect(
      shouldRestreamMobileResizeScrollback({ reason: 'apply-layout', screen: 'unknown' })
    ).toBe(false)
  })

  it('skips restream for a dimensionless mode change', () => {
    expect(shouldRestreamMobileResizeScrollback({ reason: 'display-mode', screen: 'normal' })).toBe(
      false
    )
  })
})

describe('resolveTerminalScreenKind', () => {
  it('treats a provider-preferred PTY with no tracker as unknown', () => {
    expect(
      resolveTerminalScreenKind({
        providerSnapshotPreferred: true,
        headlessAlternateScreen: false
      })
    ).toBe('unknown')
  })

  it('lets a live tracker beat stale headless evidence', () => {
    expect(
      resolveTerminalScreenKind({
        providerSnapshotPreferred: true,
        trackedAlternateScreen: false,
        headlessAlternateScreen: true
      })
    ).toBe('normal')
    expect(
      resolveTerminalScreenKind({
        providerSnapshotPreferred: true,
        trackedAlternateScreen: true,
        headlessAlternateScreen: false
      })
    ).toBe('alternate')
  })

  it('trusts positive headless evidence when the tracker is missing', () => {
    expect(
      resolveTerminalScreenKind({
        providerSnapshotPreferred: true,
        headlessAlternateScreen: true
      })
    ).toBe('alternate')
  })

  it('classifies a tracked or headless main buffer as normal', () => {
    expect(
      resolveTerminalScreenKind({
        providerSnapshotPreferred: false,
        headlessAlternateScreen: false
      })
    ).toBe('normal')
  })
})
