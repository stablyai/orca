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

  it('keeps same-named theme files from different folders apart and imports their divider colors', async () => {
    mockFiles({
      [CONFIG_PATH]: 'theme = light:/Users/alice/a/theme,dark:/Users/alice/b/theme\n',
      '/Users/alice/a/theme':
        'background = #ffffff\nforeground = #000000\nsplit-divider-color = #cccccc\n',
      '/Users/alice/b/theme':
        'background = #000000\nforeground = #ffffff\nsplit-divider-color = #333333\n'
    })

    const result = await previewGhosttyImport(createStore())

    expect(result.diff).toMatchObject({
      terminalThemeDark: 'custom:ghostty:theme',
      terminalThemeLight: 'custom:ghostty:theme-light',
      terminalDividerColorDark: '#333333',
      terminalDividerColorLight: '#cccccc'
    })
  })
})
