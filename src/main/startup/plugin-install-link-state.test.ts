import { describe, expect, it, vi } from 'vitest'
import { PluginInstallLinkState } from './skill-share-deep-link-state'
import { isRoutedOrcaDeepLink } from './orca-deep-link-url'

const LINK = 'orca://plugins/acme.dusk?catalog=community'

describe('PluginInstallLinkState', () => {
  it('queues a cold-start link until the renderer pulls it', () => {
    const state = new PluginInstallLinkState()
    expect(state.capture(['/Applications/Orca.app/Contents/MacOS/Orca', LINK])).toBe(true)
    expect(state.consume()).toBe(LINK)
    expect(state.consume()).toBeNull()
  })

  it('publishes a second-instance link and keeps malformed ones for the error toast', () => {
    const state = new PluginInstallLinkState()
    const publish = vi.fn()
    expect(state.capture(['orca.exe', 'orca://plugins/not valid'], publish)).toBe(true)
    expect(publish).toHaveBeenCalledWith('orca://plugins/not valid')
    expect(state.capture(['orca.exe', '--flag'], publish)).toBe(false)
  })

  it('drops repeats and bursts', () => {
    let now = 0
    const state = new PluginInstallLinkState(() => now)
    const publish = vi.fn()
    state.capture([LINK], publish)
    state.capture([LINK], publish)
    expect(publish).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 10; index += 1) {
      state.capture([`orca://plugins/acme.p${index}`], publish)
    }
    expect(publish).toHaveBeenCalledTimes(5)
    now = 5_000
    state.capture([LINK], publish)
    expect(publish).toHaveBeenCalledTimes(6)
  })
})

describe('isRoutedOrcaDeepLink', () => {
  it('claims plugin and skill links on macOS open-url, nothing else', () => {
    expect(isRoutedOrcaDeepLink(LINK)).toBe(true)
    expect(isRoutedOrcaDeepLink('orca://plugins/bad')).toBe(true)
    expect(isRoutedOrcaDeepLink('orca://skills/share/abc_1')).toBe(true)
    expect(isRoutedOrcaDeepLink('orca://pair?code=x')).toBe(false)
    expect(isRoutedOrcaDeepLink('https://example.com/plugins/acme.dusk')).toBe(false)
  })
})
