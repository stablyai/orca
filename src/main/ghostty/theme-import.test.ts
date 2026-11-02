import type { Store } from '../persistence/loading-store/store'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock, readFileMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('fs/promises', () => ({
  stat: statMock,
  readFile: readFileMock
}))

vi.mock('os', () => ({
  platform: vi.fn(() => 'darwin'),
  homedir: vi.fn(() => '/Users/alice')
}))

import { previewGhosttyImport } from './index'

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR

beforeEach(() => {
  delete process.env.XDG_CONFIG_HOME
  delete process.env.GHOSTTY_RESOURCES_DIR
})

afterEach(() => {
  vi.clearAllMocks()
  if (originalXdgConfigHome !== undefined) {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  } else {
    delete process.env.XDG_CONFIG_HOME
  }
  if (originalGhosttyResourcesDir !== undefined) {
    process.env.GHOSTTY_RESOURCES_DIR = originalGhosttyResourcesDir
  } else {
    delete process.env.GHOSTTY_RESOURCES_DIR
  }
})

function createStore(settings: Record<string, unknown> = {}): Store {
  return {
    getSettings: () => settings as GlobalSettings
  } as Store
}

const CONFIG_PATH = '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
const USER_THEMES = '/Users/alice/.config/ghostty/themes'

function mockFiles(files: Record<string, string>): void {
  statMock.mockImplementation(async (p: string) => {
    if (p in files) {
      return { isFile: () => true, size: files[p].length }
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  })
  readFileMock.mockImplementation(async (p: string) => files[p])
}

describe('previewGhosttyImport theme references', () => {
  it('imports a theme file as a custom theme and keeps explicit colors as overrides', async () => {
    mockFiles({
      [CONFIG_PATH]: 'theme = Tomorrow Night Bright\nbackground = #101010\nfont-size = 14\n',
      [`${USER_THEMES}/Tomorrow Night Bright`]:
        'palette = 1=#d54e53\nbackground = #000000\nforeground = #eaeaea\nfont-size = 30\n'
    })

    const result = await previewGhosttyImport(
      createStore({ terminalColorOverrides: { red: '#ff0000' } })
    )

    const [theme] = result.diff.terminalCustomThemes ?? []
    expect(theme).toMatchObject({
      id: 'ghostty:tomorrow-night-bright',
      name: 'Tomorrow Night Bright',
      source: 'ghostty',
      mode: 'dark',
      terminal: { red: '#d54e53', background: '#000000', foreground: '#eaeaea', cursor: '#eaeaea' }
    })
    expect(result.diff).toMatchObject({
      terminalFontSize: 14,
      terminalThemeDark: 'custom:ghostty:tomorrow-night-bright',
      terminalUseSeparateLightTheme: false,
      // Overrides from an earlier import must not tint the newly selected theme.
      terminalColorOverrides: { background: '#101010' }
    })
    expect(result.terminalThemes).toEqual({ dark: 'Tomorrow Night Bright' })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('maps a light/dark pair to both slots, falling back to Orca built-ins by name', async () => {
    mockFiles({
      [CONFIG_PATH]: 'theme = dark:night , light: catppuccin-latte.conf\npalette = 2=#00ff00\n',
      [`${USER_THEMES}/night`]: 'background = #000000\nforeground = #ffffff\n'
    })

    const result = await previewGhosttyImport(createStore())

    expect(result.diff).toMatchObject({
      terminalThemeDark: 'custom:ghostty:night',
      terminalThemeLight: 'Catppuccin Latte',
      terminalUseSeparateLightTheme: true,
      terminalColorOverrides: { green: '#00ff00' },
      terminalColorOverridesLight: { green: '#00ff00' }
    })
    expect(result.terminalThemes).toEqual({ dark: 'night', light: 'Catppuccin Latte' })
  })

  it('reports unresolved names and incomplete pairs without touching theme settings', async () => {
    mockFiles({ [CONFIG_PATH]: 'theme = No Such Theme\n' })
    const missing = await previewGhosttyImport(createStore())
    expect(missing.diff).toEqual({})
    expect(missing.terminalThemes).toBeUndefined()
    expect(missing.unsupportedKeys).toEqual(['theme (No Such Theme: not found)'])

    mockFiles({ [CONFIG_PATH]: 'theme = light:Catppuccin Latte\n' })
    const half = await previewGhosttyImport(createStore())
    expect(half.diff).toEqual({})
    expect(half.unsupportedKeys).toEqual([
      'theme (light:/dark: pairs need both a light and a dark theme)'
    ])
  })

  it('reports nothing to change when the same theme is imported again', async () => {
    mockFiles({
      [CONFIG_PATH]: 'theme = night\n',
      [`${USER_THEMES}/night`]: 'background = #000000\nforeground = #ffffff\n'
    })
    const first = await previewGhosttyImport(createStore())

    const second = await previewGhosttyImport(createStore({ ...first.diff }))

    expect(second.diff).toEqual({})
  })

  it('resolves an absolute theme path without probing theme search dirs', async () => {
    const themePath = '/Users/alice/themes/work'
    mockFiles({
      [CONFIG_PATH]: `theme = ${themePath}\n`,
      [themePath]: 'background = #f0f0f0\nforeground = #202020\n'
    })

    const result = await previewGhosttyImport(createStore())

    expect(result.diff.terminalThemeDark).toBe('custom:ghostty:work')
    expect(result.diff.terminalCustomThemes?.[0]?.mode).toBe('light')
    expect(statMock).not.toHaveBeenCalledWith(`${USER_THEMES}/Users/alice/themes/work`)
  })
})
