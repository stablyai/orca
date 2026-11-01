import { describe, expect, it, vi } from 'vitest'
import { clearRemovedPluginSettings } from './plugin-removal-settings'

describe('clearRemovedPluginSettings', () => {
  it("forgets only the removed plugin's consent and allowed external hosts", () => {
    const settings = {
      pluginConsents: { 'acme.gone': 'f1', 'acme.kept': 'f2' },
      disabledPlugins: ['acme.gone'],
      pluginExternalHostGrants: { 'acme.gone': ['evil.example'], 'acme.kept': ['docs.example'] }
    }
    const updateSettings = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removal reads only the plugin fields set here.
    const getSettings = () => settings as never
    clearRemovedPluginSettings({ getSettings, updateSettings }, 'acme.gone')
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginConsents: { 'acme.kept': 'f2' },
        disabledPlugins: [],
        pluginExternalHostGrants: { 'acme.kept': ['docs.example'] }
      }),
      { notifyListeners: true }
    )
  })
})
