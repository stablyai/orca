import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import {
  getTerminalViewAttributes,
  _resetTerminalViewAttributesForTest,
  markRendererCommittedSnapshot
} from './terminal-view-attribute-store'
import {
  buildSeededTerminalViewAttributesSnapshot,
  installTerminalViewAttributeNativeThemeSeeding,
  seedTerminalViewAttributesFromSettings,
  settingsAffectTerminalViewAttributes,
  _resetNativeThemeViewAttributeSeedingForTest
} from './terminal-view-attributes-seed'

const nativeThemeMock = vi.hoisted(() => {
  const listeners = new Set<(...args: unknown[]) => void>()
  return {
    shouldUseDarkColors: true,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'updated') {
        listeners.add(listener)
      }
    }),
    emitUpdated() {
      for (const listener of listeners) {
        listener()
      }
    },
    reset() {
      listeners.clear()
    }
  }
})

vi.mock('electron', () => ({
  nativeTheme: nativeThemeMock
}))

describe('terminal-view-attributes-seed', () => {
  it('composes global and per-agent snapshots from persisted settings', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      terminalThemeDark: 'Ghostty Default Style Dark',
      agentTerminalThemes: { codex: { dark: 'Dracula' } }
    }
    const snapshot = buildSeededTerminalViewAttributesSnapshot(settings, true)
    expect(snapshot.global.background).not.toEqual(snapshot.byAgent.codex?.background)
    expect(snapshot.byAgent.claude).toBeUndefined()
  })

  it('commits the seeded snapshot into the store', () => {
    _resetTerminalViewAttributesForTest()
    const settings = {
      ...getDefaultSettings('/tmp'),
      agentTerminalThemes: { codex: { dark: 'Dracula' } }
    }
    seedTerminalViewAttributesFromSettings(settings, true)
    expect(getTerminalViewAttributes(null)?.ansi).toHaveLength(256)
    expect(getTerminalViewAttributes('codex')?.background).not.toEqual(
      getTerminalViewAttributes(null)?.background
    )
  })

  it('detects theme-related settings keys', () => {
    expect(settingsAffectTerminalViewAttributes({ terminalFontSize: 14 })).toBe(false)
    expect(settingsAffectTerminalViewAttributes({ agentTerminalThemes: {} })).toBe(true)
    expect(settingsAffectTerminalViewAttributes({ theme: 'dark' })).toBe(true)
  })

  it('reseeds on nativeTheme updates until a renderer snapshot commits', () => {
    _resetTerminalViewAttributesForTest()
    _resetNativeThemeViewAttributeSeedingForTest()
    nativeThemeMock.reset()
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'system' as const,
      terminalUseSeparateLightTheme: true,
      terminalThemeDark: 'Ghostty Default Style Dark',
      terminalThemeLight: 'Builtin Tango Light'
    }
    installTerminalViewAttributeNativeThemeSeeding(() => settings)
    nativeThemeMock.shouldUseDarkColors = false
    nativeThemeMock.emitUpdated()
    const lightBackground = getTerminalViewAttributes(null)?.background
    markRendererCommittedSnapshot()
    nativeThemeMock.shouldUseDarkColors = true
    nativeThemeMock.emitUpdated()
    expect(getTerminalViewAttributes(null)?.background).toEqual(lightBackground)
  })
})
