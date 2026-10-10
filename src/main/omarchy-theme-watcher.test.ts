import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type * as OsModule from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../shared/constants'
import type { GlobalSettings } from '../shared/global-settings-types'
import {
  OMARCHY_SEED_COLOR_KEYS,
  OMARCHY_TERMINAL_THEME_SELECTION,
  type OmarchyThemePalette
} from '../shared/omarchy-theme-palette'

const mocks = vi.hoisted(() => {
  const quitListeners: (() => void)[] = []
  return {
    home: '',
    send: vi.fn<(channel: string, palette: OmarchyThemePalette) => void>(),
    quitListeners
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  homedir: () => mocks.home
}))

vi.mock('electron', () => ({
  app: {
    on: (_event: string, listener: () => void) => {
      mocks.quitListeners.push(listener)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  },
  ipcMain: { handle: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))

import { readOmarchyThemePalette } from './omarchy-theme-watcher'

function renderedOrcaJson(): Record<string, string> {
  const json: Record<string, string> = { mode: 'dark' }
  for (const key of OMARCHY_SEED_COLOR_KEYS) {
    json[key] = '#0A1220'
  }
  return json
}

describe('readOmarchyThemePalette', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-omarchy-'))
    file = join(dir, 'orca.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('derives the palette from a valid rendered orca.json on Linux', async () => {
    writeFileSync(file, JSON.stringify(renderedOrcaJson()))
    const palette = await readOmarchyThemePalette(file, 'linux')
    expect(palette?.seed.background).toBe('#0a1220')
    expect(palette?.cssVars['--background']).toBe('#0a1220')
  })

  it('returns null off Linux without reading the file', async () => {
    writeFileSync(file, JSON.stringify(renderedOrcaJson()))
    expect(await readOmarchyThemePalette(file, 'darwin')).toBeNull()
    expect(await readOmarchyThemePalette(file, 'win32')).toBeNull()
  })

  it('returns null for a missing, unresolved, or invalid file', async () => {
    expect(await readOmarchyThemePalette(file, 'linux')).toBeNull()

    writeFileSync(file, JSON.stringify({ ...renderedOrcaJson(), accent: '{{ accent }}' }))
    expect(await readOmarchyThemePalette(file, 'linux')).toBeNull()

    writeFileSync(file, '{ "mode": "dark", ')
    expect(await readOmarchyThemePalette(file, 'linux')).toBeNull()

    writeFileSync(file, JSON.stringify({ ...renderedOrcaJson(), red: 'red' }))
    expect(await readOmarchyThemePalette(file, 'linux')).toBeNull()
  })
})

// inotify delivery and file reads slow down a lot when the whole suite shares the CPU.
const FS_WAIT = { timeout: 10_000 }

describe('registerOmarchyThemeHandlers', () => {
  let home: string
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-omarchy-home-'))
    mocks.home = home
    mocks.send.mockClear()
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
  })

  afterEach(() => {
    for (const listener of mocks.quitListeners.splice(0)) {
      listener()
    }
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    rmSync(home, { recursive: true, force: true })
  })

  function writeTheme(json: Record<string, string> | string): void {
    // Mirrors `omarchy theme set`: build next-theme, then rm+mv it over theme.
    const current = join(home, '.local', 'state', 'omarchy', 'current')
    const next = join(current, 'next-theme')
    mkdirSync(next, { recursive: true })
    writeFileSync(join(next, 'orca.json'), typeof json === 'string' ? json : JSON.stringify(json))
    rmSync(join(current, 'theme'), { recursive: true, force: true })
    renameSync(next, join(current, 'theme'))
  }

  function createStore(initial: Partial<GlobalSettings>) {
    let settings: GlobalSettings = { ...getDefaultSettings(home), ...initial }
    const listeners = new Set<(updates: Partial<GlobalSettings>) => void>()
    return {
      getSettings: () => settings,
      updateSettings: (
        updates: Partial<GlobalSettings>,
        options?: { notifyListeners?: boolean }
      ) => {
        settings = { ...settings, ...updates }
        if (options?.notifyListeners) {
          for (const listener of listeners) {
            listener(updates)
          }
        }
        return settings
      },
      onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }

  const sentBackgrounds = (): string[] =>
    mocks.send.mock.calls.map(([, palette]) => palette.seed.background)

  it('watches only while selected and republishes after a theme swap', async () => {
    // Paths resolve from homedir() at import, so re-import after pointing it at the temp home.
    vi.resetModules()
    const { registerOmarchyThemeHandlers } = await import('./omarchy-theme-watcher')
    writeTheme(renderedOrcaJson())
    const store = createStore({ omarchyTheme: false })
    registerOmarchyThemeHandlers(store)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.send).not.toHaveBeenCalled()

    store.updateSettings({ omarchyTheme: true }, { notifyListeners: true })
    await vi.waitFor(() => expect(sentBackgrounds()).toEqual(['#0a1220']), FS_WAIT)
    expect(store.getSettings().theme).toBe('dark')

    writeTheme(JSON.stringify({ ...renderedOrcaJson(), background: '{{ background }}' }))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(sentBackgrounds()).toEqual(['#0a1220'])

    writeTheme({ ...renderedOrcaJson(), background: '#112233' })
    await vi.waitFor(() => expect(sentBackgrounds()).toEqual(['#0a1220', '#112233']), FS_WAIT)

    store.updateSettings({ omarchyTheme: false }, { notifyListeners: true })
    writeTheme({ ...renderedOrcaJson(), background: '#445566' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(sentBackgrounds()).toEqual(['#0a1220', '#112233'])
  })

  it('fills in the live terminal entry when the Omarchy terminal is selected elsewhere', async () => {
    vi.resetModules()
    const { registerOmarchyThemeHandlers } = await import('./omarchy-theme-watcher')
    writeTheme(renderedOrcaJson())
    const store = createStore({ omarchyTheme: true, terminalCustomThemes: [] })
    registerOmarchyThemeHandlers(store)
    await vi.waitFor(() => expect(sentBackgrounds()).toEqual(['#0a1220']), FS_WAIT)
    expect(store.getSettings().terminalCustomThemes).toEqual([])

    // e.g. an RPC write that names the selection without the custom-theme entry
    store.updateSettings(
      { terminalThemeDark: OMARCHY_TERMINAL_THEME_SELECTION },
      { notifyListeners: true }
    )
    await vi.waitFor(
      () =>
        expect(store.getSettings().terminalCustomThemes?.[0]).toMatchObject({
          id: 'omarchy:live',
          terminal: { background: '#0a1220' }
        }),
      FS_WAIT
    )
  })
})
