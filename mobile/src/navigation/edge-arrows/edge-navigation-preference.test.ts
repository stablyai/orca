import { describe, expect, it } from 'vitest'
import {
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryLayout,
  normalizeTerminalAccessoryLayoutPreference
} from '../../terminal/terminal-accessory-layout'
import {
  cycleEdgeNavigationMode,
  DEFAULT_EDGE_NAVIGATION_MODE,
  DEFAULT_EDGE_SWITCHER_CHIP_HIDDEN,
  EDGE_NAVIGATION_MODES,
  isEdgeSwitcherChipHidden,
  resolveEdgeNavigationMode,
  setTerminalEdgeNavigationMode,
  setTerminalEdgeSwitcherChipHidden
} from './edge-navigation-preference'

describe('edge navigation preference in terminal-accessory-layout', () => {
  it('resolves unset default layouts to Floating Orbs with switcher chip hidden while preserving exact default keys', () => {
    const layout = getDefaultTerminalAccessoryLayout(false)
    expect(EDGE_NAVIGATION_MODES).toEqual(['pills', 'strips', 'orbs', 'gamepad', 'off'])
    expect(Object.keys(layout).sort()).toEqual([
      'directionPadEnabled',
      'orderedBuiltInIds',
      'visibleBuiltInIds'
    ])
    expect(DEFAULT_EDGE_NAVIGATION_MODE).toBe('orbs')
    expect(DEFAULT_EDGE_SWITCHER_CHIP_HIDDEN).toBe(true)
    expect(resolveEdgeNavigationMode(layout)).toBe(DEFAULT_EDGE_NAVIGATION_MODE)
    expect(resolveEdgeNavigationMode(layout)).toBe('orbs')
    expect(isEdgeSwitcherChipHidden(layout)).toBe(true)
  })

  it('normalizes stored v2 layouts across pills, strips, orbs, gamepad, off, explicit boolean chip visibility, and unknown values', () => {
    for (const mode of ['pills', 'strips', 'orbs', 'gamepad', 'off'] as const) {
      for (const hidden of [true, false] as const) {
        const normalized = normalizeTerminalAccessoryLayoutPreference({
          version: 2,
          orderedBuiltInIds: ['escape', 'tab'],
          visibleBuiltInIds: ['escape'],
          edgeNavigationMode: mode,
          edgeSwitcherChipHidden: hidden
        })
        expect(normalized.edgeNavigationMode).toBe(mode)
        expect(resolveEdgeNavigationMode(normalized)).toBe(mode)
        expect(normalized.edgeSwitcherChipHidden).toBe(hidden)
        expect(isEdgeSwitcherChipHidden(normalized)).toBe(hidden)
      }
    }

    const fallbackMode = normalizeTerminalAccessoryLayoutPreference({
      version: 2,
      orderedBuiltInIds: ['escape'],
      visibleBuiltInIds: ['escape'],
      edgeNavigationMode: 'futuristic-unknown-mode'
    })
    expect(fallbackMode.edgeNavigationMode).toBeUndefined()
    expect(fallbackMode.edgeSwitcherChipHidden).toBeUndefined()
    expect(resolveEdgeNavigationMode(fallbackMode)).toBe('orbs')
    expect(isEdgeSwitcherChipHidden(fallbackMode)).toBe(true)
  })

  it('cycles through all four active flavours including gamepad in deterministic order and wakes off into orbs', () => {
    expect(cycleEdgeNavigationMode('pills')).toBe('strips')
    expect(cycleEdgeNavigationMode('strips')).toBe('orbs')
    expect(cycleEdgeNavigationMode('orbs')).toBe('gamepad')
    expect(cycleEdgeNavigationMode('gamepad')).toBe('pills')
    expect(cycleEdgeNavigationMode('off')).toBe('orbs')
  })

  it('updates mode and switcher chip visibility (both opt-in false and hidden true) without dropping shortcut ordering', () => {
    const base = createTerminalAccessoryLayoutPreference(
      {
        orderedBuiltInIds: ['tab', 'escape'],
        visibleBuiltInIds: ['tab'],
        directionPadEnabled: false
      },
      ['escape', 'tab']
    )
    expect(isEdgeSwitcherChipHidden(base)).toBe(true)

    const shownChip = setTerminalEdgeSwitcherChipHidden(base, false, ['escape', 'tab'])
    expect(shownChip.edgeSwitcherChipHidden).toBe(false)
    expect(isEdgeSwitcherChipHidden(shownChip)).toBe(false)

    const gamepadLayout = setTerminalEdgeNavigationMode(shownChip, 'gamepad', ['escape', 'tab'])
    expect(gamepadLayout.edgeNavigationMode).toBe('gamepad')
    expect(gamepadLayout.edgeSwitcherChipHidden).toBe(false)
    expect(isEdgeSwitcherChipHidden(gamepadLayout)).toBe(false)
    expect(gamepadLayout.orderedBuiltInIds).toEqual(['tab', 'escape'])
    expect(gamepadLayout.visibleBuiltInIds).toEqual(['tab'])
    expect(gamepadLayout.directionPadEnabled).toBe(false)

    const hiddenChip = setTerminalEdgeSwitcherChipHidden(gamepadLayout, true, ['escape', 'tab'])
    expect(hiddenChip.edgeNavigationMode).toBe('gamepad')
    expect(hiddenChip.edgeSwitcherChipHidden).toBe(true)
    expect(isEdgeSwitcherChipHidden(hiddenChip)).toBe(true)
  })
})
