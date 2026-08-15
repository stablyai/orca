import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../shared/constants'
import { createPortableSettingsBundle } from '../shared/portable-settings'
import { createPortableSettingsRuntimeService } from './portable-settings-service'

describe('portable settings runtime service', () => {
  it('applies only selected categories and remaps imported shortcuts', () => {
    let settings = getDefaultSettings('/home/test')
    const updateSettings = vi.fn((updates) => {
      settings = { ...settings, ...updates }
      return settings
    })
    let targetOverrides = {}
    const keybindings = {
      getSnapshot: vi.fn(() => ({
        platform: 'linux' as const,
        overrides: targetOverrides,
        path: '/home/test/.orca/keybindings.json',
        exists: true,
        commonOverrides: {},
        platformOverrides: {},
        diagnostics: []
      })),
      validateOverrides: vi.fn((overrides) => overrides),
      replaceOverrides: vi.fn((overrides) => {
        targetOverrides = overrides
        return { ...keybindings.getSnapshot(), overrides }
      })
    }
    const onKeybindingsChanged = vi.fn()
    const runWithoutOutboundSyncSpy = vi.fn()
    const runWithoutOutboundSync = <T>(operation: () => T): T => {
      runWithoutOutboundSyncSpy()
      return operation()
    }
    const service = createPortableSettingsRuntimeService(
      { getSettings: () => settings, updateSettings } as never,
      keybindings,
      { onKeybindingsChanged, runWithoutOutboundSync }
    )
    const source = createPortableSettingsBundle(
      {
        ...getDefaultSettings('/home/test'),
        theme: 'dark',
        editorAutoSave: !settings.editorAutoSave,
        defaultTuiAgent: 'codex'
      },
      { platform: 'darwin', overrides: { 'app.settings': ['Cmd+Comma'] } }
    )

    const result = service.apply({ categories: ['appearance', 'input'], bundle: source })

    expect(settings.theme).toBe('dark')
    expect(settings.editorAutoSave).toBe(source.categories.input.editorAutoSave)
    expect(settings.defaultTuiAgent).toBe(getDefaultSettings('/home/test').defaultTuiAgent)
    expect(keybindings.replaceOverrides).toHaveBeenCalledWith({
      'app.settings': ['Ctrl+Comma']
    })
    expect(keybindings.validateOverrides.mock.invocationCallOrder[0]).toBeLessThan(
      updateSettings.mock.invocationCallOrder[0]
    )
    expect(onKeybindingsChanged).toHaveBeenCalledOnce()
    expect(runWithoutOutboundSyncSpy).toHaveBeenCalledOnce()
    expect(result.appliedCategories).toEqual(['appearance', 'input'])
  })

  it('rolls settings back when shortcut persistence fails', () => {
    const originalSettings = getDefaultSettings('/home/test')
    let settings = originalSettings
    const updateSettings = vi.fn((updates) => {
      settings = {
        ...settings,
        ...updates,
        agentDefaultArgs: { ...settings.agentDefaultArgs, claude: '--side-effect' }
      }
      return settings
    })
    const restoreSettingsSnapshot = vi.fn((snapshot) => {
      settings = structuredClone(snapshot)
      return settings
    })
    const keybindings = {
      getSnapshot: vi.fn(() => ({
        platform: 'linux' as const,
        overrides: {},
        path: '/home/test/.orca/keybindings.json',
        exists: true,
        commonOverrides: {},
        platformOverrides: {},
        diagnostics: []
      })),
      validateOverrides: vi.fn((overrides) => overrides),
      replaceOverrides: vi.fn(() => {
        throw new Error('disk full')
      })
    }
    const service = createPortableSettingsRuntimeService(
      { getSettings: () => settings, updateSettings, restoreSettingsSnapshot } as never,
      keybindings as never
    )
    const source = createPortableSettingsBundle(
      { ...originalSettings, editorAutoSave: !originalSettings.editorAutoSave },
      { platform: 'linux', overrides: { 'app.settings': ['Ctrl+Comma'] } }
    )

    expect(() => service.apply({ categories: ['input'], bundle: source })).toThrow('disk full')

    expect(keybindings.validateOverrides.mock.invocationCallOrder[0]).toBeLessThan(
      keybindings.replaceOverrides.mock.invocationCallOrder[0]
    )
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(restoreSettingsSnapshot).toHaveBeenCalledOnce()
    expect(settings).toEqual(originalSettings)
  })

  it('does not persist shortcuts when the settings write fails', () => {
    const settings = getDefaultSettings('/home/test')
    const updateSettings = vi.fn(() => {
      throw new Error('settings unavailable')
    })
    const keybindings = {
      getSnapshot: vi.fn(() => ({
        platform: 'linux' as const,
        overrides: {},
        path: '/home/test/.orca/keybindings.json',
        exists: true,
        commonOverrides: {},
        platformOverrides: {},
        diagnostics: []
      })),
      validateOverrides: vi.fn((overrides) => overrides),
      replaceOverrides: vi.fn()
    }
    const service = createPortableSettingsRuntimeService(
      { getSettings: () => settings, updateSettings } as never,
      keybindings as never
    )
    const source = createPortableSettingsBundle(
      { ...settings, editorAutoSave: !settings.editorAutoSave },
      {
        platform: 'linux',
        overrides: { 'app.settings': ['Ctrl+Comma'] }
      }
    )

    expect(() => service.apply({ categories: ['input'], bundle: source })).toThrow(
      'settings unavailable'
    )
    expect(keybindings.validateOverrides).toHaveBeenCalledOnce()
    expect(keybindings.replaceOverrides).not.toHaveBeenCalled()
  })

  it('finishes the import when a settings listener throws after persistence', () => {
    let settings = getDefaultSettings('/home/test')
    const updateSettings = vi.fn((updates) => {
      settings = { ...settings, ...updates }
      throw new Error('listener closed')
    })
    const snapshot = {
      platform: 'linux' as const,
      overrides: {},
      path: '/home/test/.orca/keybindings.json',
      exists: true,
      commonOverrides: {},
      platformOverrides: {},
      diagnostics: []
    }
    const keybindings = {
      getSnapshot: vi.fn(() => snapshot),
      validateOverrides: vi.fn((overrides) => overrides),
      replaceOverrides: vi.fn(() => snapshot)
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = createPortableSettingsRuntimeService(
      { getSettings: () => settings, updateSettings } as never,
      keybindings as never
    )
    const source = createPortableSettingsBundle(
      { ...settings, editorAutoSave: !settings.editorAutoSave },
      {
        platform: 'linux',
        overrides: { 'app.settings': ['Ctrl+Comma'] }
      }
    )

    expect(service.apply({ categories: ['input'], bundle: source }).appliedCategories).toEqual([
      'input'
    ])
    expect(keybindings.replaceOverrides).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to broadcast imported settings:',
      expect.any(Error)
    )
    consoleError.mockRestore()
  })

  it('does not report a failed import when only the refresh callback fails', () => {
    let settings = getDefaultSettings('/home/test')
    const updateSettings = vi.fn((updates) => {
      settings = { ...settings, ...updates }
      return settings
    })
    const snapshot = {
      platform: 'linux' as const,
      overrides: {},
      path: '/home/test/.orca/keybindings.json',
      exists: true,
      commonOverrides: {},
      platformOverrides: {},
      diagnostics: []
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = createPortableSettingsRuntimeService(
      { getSettings: () => settings, updateSettings } as never,
      {
        getSnapshot: () => snapshot,
        validateOverrides: (overrides) => overrides,
        replaceOverrides: () => snapshot
      } as never,
      {
        onKeybindingsChanged: () => {
          throw new Error('window closed')
        }
      }
    )
    const source = createPortableSettingsBundle(settings, {
      platform: 'linux',
      overrides: {}
    })

    expect(service.apply({ categories: ['input'], bundle: source }).appliedCategories).toEqual([
      'input'
    ])
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to broadcast imported keybindings:',
      expect.any(Error)
    )
    consoleError.mockRestore()
  })

  it('sanitizes terminal theme colors received over RPC', () => {
    const settings = getDefaultSettings('/home/test')
    const updateSettings = vi.fn()
    const service = createPortableSettingsRuntimeService(
      { getSettings: () => settings, updateSettings } as never,
      {
        getSnapshot: () => ({
          platform: 'linux',
          overrides: {},
          path: '/home/test/.orca/keybindings.json',
          exists: false,
          commonOverrides: {},
          platformOverrides: {},
          diagnostics: []
        }),
        validateOverrides: vi.fn((overrides) => overrides),
        replaceOverrides: vi.fn()
      }
    )
    const source = createPortableSettingsBundle(
      {
        ...settings,
        terminalColorOverrides: { foreground: 'not-a-color', background: '#abc' },
        terminalCustomThemes: [
          {
            id: 'manual:unsafe',
            name: 'Unsafe',
            source: 'manual',
            mode: 'dark',
            terminal: {
              foreground: '#ffffff',
              background: 'not-a-color',
              black: '#000000'
            },
            importedAt: new Date(0).toISOString()
          }
        ]
      },
      { platform: 'linux', overrides: {} }
    )

    service.apply({ categories: ['appearance'], bundle: source })

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalColorOverrides: { background: '#aabbcc' },
        terminalCustomThemes: []
      }),
      { notifyListeners: true }
    )
  })

  it('never accepts sensitive or unknown settings in an apply request', () => {
    const settings = getDefaultSettings('/home/test')
    const service = createPortableSettingsRuntimeService(
      {
        getSettings: () => settings,
        updateSettings: vi.fn()
      } as never,
      {
        getSnapshot: () => ({
          platform: 'linux',
          overrides: {},
          path: '/home/test/.orca/keybindings.json',
          exists: false,
          commonOverrides: {},
          platformOverrides: {},
          diagnostics: []
        }),
        validateOverrides: vi.fn((overrides) => overrides),
        replaceOverrides: vi.fn()
      }
    )
    const source = createPortableSettingsBundle(settings, {
      platform: 'linux',
      overrides: {}
    })

    expect(() =>
      service.apply({
        categories: ['appearance'],
        bundle: {
          ...source,
          categories: {
            ...source.categories,
            appearance: {
              ...source.categories.appearance,
              opencodeSessionCookie: 'secret'
            }
          }
        }
      } as never)
    ).toThrow()
  })
})
