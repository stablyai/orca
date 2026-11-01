import { describe, expect, it } from 'vitest'
import {
  isPluginFrameIsolationEnabled,
  PLUGIN_ISOLATED_FRAMES_DEFAULT
} from './plugin-frame-isolation'

describe('isolated frames switch', () => {
  it('defaults off, follows the setting, and lets the env var override either way', () => {
    expect(PLUGIN_ISOLATED_FRAMES_DEFAULT).toBe(false)
    expect(isPluginFrameIsolationEnabled({}, {})).toBe(false)
    expect(isPluginFrameIsolationEnabled({ experimentalPluginIsolatedFrames: true }, {})).toBe(true)
    expect(isPluginFrameIsolationEnabled({}, { ORCA_PLUGIN_ISOLATED_FRAMES: '1' })).toBe(true)
    expect(
      isPluginFrameIsolationEnabled(
        { experimentalPluginIsolatedFrames: true },
        { ORCA_PLUGIN_ISOLATED_FRAMES: '0' }
      )
    ).toBe(false)
    expect(isPluginFrameIsolationEnabled(null, { ORCA_PLUGIN_ISOLATED_FRAMES: 'yes' })).toBe(false)
  })
})
