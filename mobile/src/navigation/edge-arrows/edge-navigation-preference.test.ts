import { describe, expect, it } from 'vitest'
import {
  createTerminalAccessoryLayoutPreference,
  getDefaultTerminalAccessoryLayout,
  normalizeTerminalAccessoryLayoutPreference
} from '../../terminal/terminal-accessory-layout'
import {
  cycleEdgeNavigationMode,
  DEFAULT_EDGE_NAVIGATION_MODE,
  EDGE_NAVIGATION_MODES,
  isEdgeSwitcherChipHidden,
  resolveEdgeNavigationMode,
  setTerminalEdgeNavigationMode,
  setTerminalEdgeSwitcherChipHidden
} from './edge-navigation-preference'

describe('edge navigation preference in terminal-accessory-layout', () => {
  it('resolves unset default layouts to pills with switcher chip visible while preserving exact default keys', () => {
    const layout = getDefaultTerminalAccessoryLayout(false)
    expect(EDGE_NAVIGATION_MODES).toEqual(['pills', 'strips', 'orbs', 'gamepad', 'off'])
    expect(resolveEdgeNavigationMode(layout)).toBe(DEFAULT_EDGE_NAVIGATION_MODE)
    expect(resolveEdgeNavigationMode(layout)).toBe('pills')
    expect(isEdgeSwitcherChipHidden(layout)).toBe(false)
  })

  it('normalizes stored v2 layouts across pills, strips, orbs, gamepad, off, and unknown values', () => {
    for (const mode of ['pills', 'strips', 'orbs', 'gamepad', 'off'] as const) {
      const normalized = normalizeTerminalAccessoryLayoutPreference({
        version: 2,
        orderedBuiltInIds: ['escape', 'tab'],
        visibleBuiltInIds: ['escape'],
        edgeNavigationMode: mode,
        edgeSwitcherChipHidden: true
      })
      expect(normalized.edgeNavigationMode).toBe(mode)
      expect(resolveEdgeNavigationMode(normalized)).toBe(mode)
      expect(normalized.edgeSwitcherChipHidden).toBe(true)
      expect(isEdgeSwitcherChipHidden(normalized)).toBe(true)
    }

    const fallbackMode = normalizeTerminalAccessoryLayoutPreference({
      version: 2,
      orderedBuiltInIds: ['escape'],
      visibleBuiltInIds: ['escape'],
      edgeNavigationMode: 'futuristic-unknown-mode'
    })
    expect(fallbackMode.edgeNavigationMode).toBeUndefined()
    expect(resolveEdgeNavigationMode(fallbackMode)).toBe('pills')
    expect(isEdgeSwitcherChipHidden(fallbackMode)).toBe(false)
  })

  it('cycles through all four active flavours including gamepad in deterministic order', () => {
    expect(cycleEdgeNavigationMode('pills')).toBe('strips')
    expect(cycleEdgeNavigationMode('strips')).toBe('orbs')
    expect(cycleEdgeNavigationMode('orbs')).toBe('gamepad')
    expect(cycleEdgeNavigationMode('gamepad')).toBe('pills')
    expect(cycleEdgeNavigationMode('off')).toBe('pills')
  })

  it('updates mode and switcher chip visibility without dropping shortcut ordering', () => {
    const base = createTerminalAccessoryLayoutPreference(
      {
        orderedBuiltInIds: ['tab', 'escape'],
        visibleBuiltInIds: ['tab'],
        directionPadEnabled: false
      },
      ['escape', 'tab']
    )
    const gamepadLayout = setTerminalEdgeNavigationMode(base, 'gamepad', ['escape', 'tab'])
    expect(gamepadLayout.edgeNavigationMode).toBe('gamepad')
    expect(gamepadLayout.orderedBuiltInIds).toEqual(['tab', 'escape'])
    expect(gamepadLayout.visibleBuiltInIds).toEqual(['tab'])
    expect(gamepadLayout.directionPadEnabled).toBe(false)

    const hiddenChip = setTerminalEdgeSwitcherChipHidden(gamepadLayout, true, ['escape', 'tab'])
    expect(hiddenChip.edgeNavigationMode).toBe('gamepad')
    expect(hiddenChip.edgeSwitcherChipHidden).toBe(true)
    expect(isEdgeSwitcherChipHidden(hiddenChip)).toBe(true)
  })
})
