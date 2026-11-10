import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PluginEventName } from '../../../shared/plugins/manifest/plugin-manifest'
import { executePluginHostCall, type PluginHostServices } from '../workers/plugin-host-methods'
import {
  createPluginEditorTypographySource,
  watchPluginEditorTypography,
  type PluginEditorTypographySource
} from './plugin-editor-typography'

type Zoom = { editorFontZoomLevel: number }
type SettingsListener = (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void

function fakeStore(initial: Partial<GlobalSettings>, zoom = 0) {
  const settingsListeners = new Set<SettingsListener>()
  const uiListeners = new Set<(ui: Zoom) => void>()
  let settings: Partial<GlobalSettings> = { ...initial }
  let ui: Zoom = { editorFontZoomLevel: zoom }
  // Why Partial: the resolver reads only the editor and terminal font keys.
  const full = (): GlobalSettings => Object.assign(Object.create(null), settings)
  return {
    getSettings: full,
    getUI: () => ui,
    onSettingsChanged: (listener: SettingsListener) => {
      settingsListeners.add(listener)
      return () => void settingsListeners.delete(listener)
    },
    onUIChanged: (listener: (ui: Zoom) => void) => {
      uiListeners.add(listener)
      return () => void uiListeners.delete(listener)
    },
    setSettings(updates: Partial<GlobalSettings>) {
      settings = { ...settings, ...updates }
      for (const listener of settingsListeners) {
        listener(updates, full())
      }
    },
    /** A write made without `notifyListeners`, as some main-process callers do. */
    setSettingsSilently(updates: Partial<GlobalSettings>) {
      settings = { ...settings, ...updates }
    },
    setZoom(level: number) {
      ui = { editorFontZoomLevel: level }
      for (const listener of uiListeners) {
        listener(ui)
      }
    }
  }
}

function fakeEvents(wanted = true) {
  const emitted: unknown[] = []
  return {
    emitted,
    events: {
      wantsEvent: vi.fn((_event: PluginEventName) => wanted),
      emitEvent: vi.fn((_event: PluginEventName, payload: unknown) => void emitted.push(payload))
    }
  }
}

function hostServices(editorTypography: PluginEditorTypographySource | null): PluginHostServices {
  return {
    editorTypography,
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    listAgentStatuses: () => [],
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn().mockReturnValue([]) },
    secrets: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      protection: vi.fn().mockReturnValue('unavailable')
    },
    settings: { getAll: vi.fn().mockReturnValue({}), set: vi.fn() }
  }
}

describe('editor typography source', () => {
  it("resolves what Orca's file editor uses, zoom and word wrap included", () => {
    const store = fakeStore(
      {
        terminalFontFamily: 'Menlo',
        terminalFontSize: 14,
        editorFontFamily: 'JetBrains Mono',
        editorFontSize: 15,
        editorFontWeight: 450,
        editorLineHeight: 1.5,
        editorLigatures: 'on',
        editorWordWrap: false,
        editorMinimapEnabled: true
      },
      2
    )
    expect(createPluginEditorTypographySource(store).read()).toEqual({
      fontFamily: 'JetBrains Mono',
      cssFontFamily: expect.stringMatching(/^"JetBrains Mono", /),
      fontSize: 17,
      fontWeight: '450',
      lineHeight: 26,
      fontLigatures: true,
      wordWrap: 'off',
      minimap: true
    })
  })

  it('follows the terminal font when the editor keys are unset', () => {
    const store = fakeStore({ terminalFontFamily: 'Menlo', terminalFontSize: 14 })
    expect(createPluginEditorTypographySource(store).read()).toMatchObject({
      fontFamily: 'Menlo',
      fontSize: 14,
      fontWeight: 'normal',
      lineHeight: 0,
      fontLigatures: false,
      wordWrap: 'on',
      minimap: false
    })
  })

  it('survives a non-string font family from a hand-edited profile', () => {
    const store = fakeStore({ terminalFontSize: 14, terminalFontFamily: Object(42) })
    expect(createPluginEditorTypographySource(store).read().fontFamily).toBe('monospace')
  })

  it('treats a non-numeric zoom as unzoomed', () => {
    const store = fakeStore({ terminalFontSize: 14 }, Number.NaN)
    expect(createPluginEditorTypographySource(store).read().fontSize).toBe(14)
  })
})

describe('watchPluginEditorTypography', () => {
  it('emits on a zoom or font change, not on unrelated writes', () => {
    const store = fakeStore({ terminalFontSize: 14 })
    const { events, emitted } = fakeEvents()
    watchPluginEditorTypography({ store, events: () => events })
    store.setZoom(0)
    store.setSettings({ terminalCursorBlink: true })
    expect(emitted).toEqual([])
    store.setZoom(1)
    store.setSettings({ editorFontSize: 18 })
    expect(emitted).toEqual([
      expect.objectContaining({ fontSize: 15 }),
      expect.objectContaining({ fontSize: 19 })
    ])
  })

  it('carries the live settings after a write that did not notify', () => {
    const store = fakeStore({ terminalFontSize: 14 })
    const { events, emitted } = fakeEvents()
    watchPluginEditorTypography({ store, events: () => events })
    store.setSettingsSilently({ editorFontFamily: 'Fira Code' })
    store.setZoom(1)
    expect(emitted).toEqual([expect.objectContaining({ fontFamily: 'Fira Code', fontSize: 15 })])
  })

  it('stays quiet without listeners, and a later listener hears only later changes', () => {
    const store = fakeStore({ terminalFontSize: 14 })
    const { events, emitted } = fakeEvents(false)
    watchPluginEditorTypography({ store, events: () => events })
    store.setZoom(3)
    expect(events.emitEvent).not.toHaveBeenCalled()
    events.wantsEvent.mockReturnValue(true)
    store.setSettings({ terminalCursorBlink: true })
    expect(emitted).toEqual([])
    store.setZoom(4)
    expect(emitted).toEqual([expect.objectContaining({ fontSize: 18 })])
  })
})

describe('editor.readTypography', () => {
  it('needs no capability and answers on every surface', async () => {
    const source = createPluginEditorTypographySource(fakeStore({ terminalFontSize: 14 }))
    const surfaces = ['worker', 'panel', 'editor'] as const
    const outcomes = await Promise.all(
      surfaces.map((surface) =>
        executePluginHostCall({
          pluginId: 'samples.demo',
          method: 'editor.readTypography',
          params: {},
          surface,
          grantedCapabilities: [],
          services: hostServices(source)
        })
      )
    )
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ ok: true, value: { fontSize: 14, wordWrap: 'on' } })
    }
  })

  it('is unavailable where no profile settings are loaded', async () => {
    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'editor.readTypography',
      params: {},
      surface: 'worker',
      grantedCapabilities: [],
      services: hostServices(null)
    })
    expect(outcome).toMatchObject({ ok: false, code: 'unavailable' })
  })
})
