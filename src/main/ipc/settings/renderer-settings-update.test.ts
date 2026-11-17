import { describe, expect, it } from 'vitest'
import {
  RENDERER_DENIED_SETTINGS_KEYS,
  sanitizeRendererSettingsUpdate
} from './renderer-settings-update'

describe('renderer settings update sanitization', () => {
  it('denies the settings file seen-keys list to the renderer', () => {
    expect(RENDERER_DENIED_SETTINGS_KEYS).toContain('settingsFileLastSeenKeys')
  })

  it('strips denied keys from a payload and keeps the rest', () => {
    const sanitized = sanitizeRendererSettingsUpdate({
      settingsFileLastSeenKeys: ['theme'],
      activeRuntimeEnvironmentId: 'env-1',
      terminalFontSize: 18
    })

    expect(sanitized).toEqual({ terminalFontSize: 18 })
  })
})
