import { describe, expect, it } from 'vitest'
import {
  BrowserExtensionActionState,
  browserExtensionColorToCss,
  parseBrowserExtensionColor,
  readManifestActionDefaults
} from './browser-extension-action-state'

function stateFor(manifest: Record<string, unknown>): BrowserExtensionActionState {
  return new BrowserExtensionActionState(readManifestActionDefaults(manifest, 'Vault'))
}

describe('chrome.action state', () => {
  it('starts from manifest.action, falling back to the extension name and its icons', () => {
    expect(
      stateFor({
        action: { default_title: 'Open vault', default_popup: 'popup.html' },
        icons: { 16: 'i16.png', 48: 'i48.png' }
      }).get()
    ).toEqual({
      title: 'Open vault',
      popup: 'popup.html',
      badgeText: '',
      badgeBackgroundColor: null,
      badgeTextColor: null,
      enabled: true,
      icon: { kind: 'path', paths: { 16: 'i16.png', 48: 'i48.png' } }
    })
    // MV2 names it browser_action; a missing title shows the extension's name.
    expect(stateFor({ browser_action: { default_icon: 'b.png' } }).get()).toMatchObject({
      title: 'Vault',
      popup: '',
      icon: { kind: 'path', paths: { 16: 'b.png' } }
    })
  })

  it('lets a tab override the global value on that tab only', () => {
    const state = stateFor({ action: {} })
    state.set('badgeText', '3')
    state.set('badgeText', '9', 7)
    state.set('enabled', false, 7)
    expect(state.get(7)).toMatchObject({ badgeText: '9', enabled: false })
    expect(state.get(8)).toMatchObject({ badgeText: '3', enabled: true })
    expect(state.get()).toMatchObject({ badgeText: '3', enabled: true })
  })

  it('falls back a level when a value is cleared', () => {
    const state = stateFor({ action: { default_title: 'Manifest title' } })
    state.set('title', 'Global')
    state.set('title', 'Tab', 7)
    state.set('title', null, 7)
    expect(state.get(7).title).toBe('Global')
    state.set('title', null)
    expect(state.get(7).title).toBe('Manifest title')
  })

  it("drops a tab's overrides when the tab moves on, and says whether it had any", () => {
    const state = stateFor({ action: {} })
    state.set('badgeText', 'ON', 7)
    expect(state.forgetTab(7)).toBe(true)
    expect(state.get(7).badgeText).toBe('')
    expect(state.forgetTab(7)).toBe(false)
  })

  it('shows a blocked-request count over the global text, under the tab text', () => {
    const state = stateFor({ action: {} })
    state.set('badgeText', 'on')
    expect(state.setActionCount(7, 12)).toBe(true)
    expect(state.setActionCount(7, 12)).toBe(false)
    expect([state.get(7).badgeText, state.get(8).badgeText, state.get().badgeText]).toEqual([
      '12',
      'on',
      'on'
    ])
    state.set('badgeText', 'mine', 7)
    expect(state.get(7).badgeText).toBe('mine')
    expect(state.forgetTab(7)).toBe(true)
    state.setActionCount(7, 3)
    expect(state.clearActionCounts()).toBe(true)
    expect(state.get(7).badgeText).toBe('on')
  })
})

describe('badge colors', () => {
  it.each([
    [
      [255, 0, 0, 255],
      [255, 0, 0, 255]
    ],
    ['#f00', [255, 0, 0, 255]],
    ['#00ff0080', [0, 255, 0, 128]],
    ['rgb(1, 2, 3)', [1, 2, 3, 255]],
    ['rgba(10, 20, 30, 0.5)', [10, 20, 30, 128]]
  ])('parses %j', (input, expected) => {
    expect(parseBrowserExtensionColor(input)).toEqual(expected)
  })

  it.each([['blurple'], [[1, 2, 3]], ['#12'], [42]])('rejects %j', (input) => {
    expect(parseBrowserExtensionColor(input)).toBeNull()
  })

  it('renders a color as CSS', () => {
    expect(browserExtensionColorToCss([10, 20, 30, 128])).toBe('rgba(10, 20, 30, 0.502)')
    expect(browserExtensionColorToCss(null)).toBeNull()
  })
})
