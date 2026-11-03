import { describe, expect, it } from 'vitest'
import {
  isPluginShotWindowShown,
  pluginShotActRefusal,
  pluginShotThemeDecision,
  PLUGIN_SHOT_VISIBLE_THEME_REASON
} from './plugin-shot-policy'

const window = (state: { visible: boolean; minimized: boolean; destroyed?: boolean }) => ({
  isDestroyed: () => state.destroyed === true,
  isVisible: () => state.visible,
  isMinimized: () => state.minimized
})

describe('isPluginShotWindowShown', () => {
  it('is true only for a visible window that is not minimized', () => {
    expect(isPluginShotWindowShown(window({ visible: true, minimized: false }))).toBe(true)
    expect(isPluginShotWindowShown(window({ visible: false, minimized: false }))).toBe(false)
    expect(isPluginShotWindowShown(window({ visible: true, minimized: true }))).toBe(false)
    expect(
      isPluginShotWindowShown(window({ visible: true, minimized: false, destroyed: true }))
    ).toBe(false)
  })
})

describe('pluginShotThemeDecision', () => {
  it('applies --theme only while the window is out of sight', () => {
    expect(pluginShotThemeDecision('light', false)).toEqual({ colorScheme: 'light' })
    expect(pluginShotThemeDecision('light', true)).toEqual({
      themeReason: PLUGIN_SHOT_VISIBLE_THEME_REASON
    })
    expect(pluginShotThemeDecision(undefined, true)).toEqual({})
  })
})

describe('pluginShotActRefusal', () => {
  it('acts only on a components panel while the window is out of sight', () => {
    expect(pluginShotActRefusal('components', false)).toBeNull()
    expect(pluginShotActRefusal('components', true)).toMatchObject({ reason: 'window_shown' })
    expect(pluginShotActRefusal('html', false)).toMatchObject({ reason: 'act_unsupported' })
  })
})
