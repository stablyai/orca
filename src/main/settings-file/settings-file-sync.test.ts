import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { SettingsUpdateOptions } from '../persistence/applying-settings/settings-update'
import { createSettingsFileSync } from './settings-file-sync'
import type {
  SettingsFileStore,
  SettingsFileSync,
  WatchSettingsFile
} from './settings-file-sync-types'

type PersistedListener = Parameters<SettingsFileStore['onSettingsPersisted']>[0]

function createFakeStore(
  initial: Partial<GlobalSettings>,
  defaults: GlobalSettings
): SettingsFileStore {
  let settings: GlobalSettings = { ...defaults, ...initial }
  const listeners = new Set<PersistedListener>()
  return {
    getSettings: () => settings,
    updateSettings: (updates: Partial<GlobalSettings>, options: SettingsUpdateOptions = {}) => {
      const changed = Object.fromEntries(
        Object.entries(updates).filter(
          ([key, value]) =>
            !Object.is(Object.entries(settings).find(([k]) => k === key)?.[1], value)
        )
      )
      settings = { ...settings, ...updates }
      if (Object.keys(changed).length > 0) {
        for (const listener of listeners) {
          listener(changed, options.origin)
        }
      }
      return settings
    },
    onSettingsPersisted: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

const idleWatch: WatchSettingsFile = () => ({
  refresh: async () => {},
  isBound: () => false,
  close: async () => {}
})

describe('settings file sync', () => {
  let home: string
  let filePath: string
  let defaults: GlobalSettings
  let active: SettingsFileSync[]

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-settings-file-'))
    filePath = join(home, '.orca', 'settings.json')
    defaults = getDefaultSettings(home)
    active = []
  })

  afterEach(async () => {
    await Promise.all(active.map((sync) => sync.dispose()))
    await chmod(join(home, '.orca'), 0o755).catch(() => {})
    await rm(home, { recursive: true, force: true })
  })

  async function writeSettingsText(text: string, path = filePath): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, text)
  }

  async function readJson(path = filePath): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path, 'utf-8'))
  }

  async function startSync(
    initial: Partial<GlobalSettings> = {},
    options: {
      debounceMs?: number
      watchFile?: WatchSettingsFile
      refreshIntervalMs?: number
    } = {}
  ): Promise<{ sync: SettingsFileSync; store: SettingsFileStore }> {
    const store = createFakeStore(initial, defaults)
    const sync = createSettingsFileSync({
      filePath,
      store,
      defaults,
      watchFile: options.watchFile ?? idleWatch,
      log: { info: () => {}, warn: () => {} },
      debounceMs: options.debounceMs ?? 5,
      refreshIntervalMs: options.refreshIntervalMs
    })
    active.push(sync)
    await sync.start()
    return { sync, store }
  }

  it('applies an external edit, reports non-portable and unknown keys, and keeps them in the file', async () => {
    await writeSettingsText(
      JSON.stringify({ theme: 'dark', activeRuntimeEnvironmentId: 'env-1', futureKey: 7 })
    )
    const { sync, store } = await startSync()

    expect(store.getSettings().theme).toBe('dark')
    expect(store.getSettings().activeRuntimeEnvironmentId).toBe(defaults.activeRuntimeEnvironmentId)
    expect(sync.getStatus()).toMatchObject({
      state: 'active',
      appliedKeyCount: 1,
      ignored: [
        { key: 'activeRuntimeEnvironmentId', reason: 'not-portable' },
        { key: 'futureKey', reason: 'unknown' }
      ]
    })

    store.updateSettings({ terminalFontSize: 21 })
    await sync.flush()

    expect(await readJson()).toEqual({
      theme: 'dark',
      activeRuntimeEnvironmentId: 'env-1',
      futureKey: 7,
      terminalFontSize: 21
    })
  })

  it('reports a portable key with a wrong-typed value as invalid and leaves the store alone', async () => {
    await writeSettingsText(JSON.stringify({ theme: 'neon', terminalFontSize: '14' }))
    const { sync, store } = await startSync()

    expect(store.getSettings().theme).toBe(defaults.theme)
    expect(store.getSettings().terminalFontSize).toBe(defaults.terminalFontSize)
    expect(sync.getStatus().ignored).toEqual([
      { key: 'theme', reason: 'invalid-value' },
      { key: 'terminalFontSize', reason: 'invalid-value' }
    ])
  })

  it('writes only the changed key, keeps order and unknown keys, and writes default-equal values', async () => {
    await writeSettingsText(JSON.stringify({ futureKey: 1, theme: 'dark', terminalFontSize: 19 }))
    const { sync, store } = await startSync()

    store.updateSettings({ theme: defaults.theme })
    store.updateSettings({ editorFontSize: 15 })
    await sync.flush()

    const written = await readJson()
    expect(Object.keys(written)).toEqual([
      'futureKey',
      'theme',
      'terminalFontSize',
      'editorFontSize'
    ])
    expect(written).toMatchObject({ futureKey: 1, theme: defaults.theme, terminalFontSize: 19 })
  })

  it('does not write while the file is invalid and flushes the pending value once it is fixed', async () => {
    await writeSettingsText('{ not json')
    const { sync, store } = await startSync()
    expect(sync.getStatus().state).toBe('invalid')

    store.updateSettings({ terminalFontSize: 23 })
    await sync.flush()
    expect(await readFile(filePath, 'utf-8')).toBe('{ not json')

    await writeSettingsText('{ "theme": "dark" }')
    await sync.refresh()

    expect(await readJson()).toEqual({ theme: 'dark', terminalFontSize: 23 })
    expect(sync.getStatus().state).toBe('active')
  })

  it('resets a key removed from the file to its default but keeps never-seen keys', async () => {
    await writeSettingsText(JSON.stringify({ terminalFontSize: 22 }))
    const { sync, store } = await startSync({ theme: 'dark' })
    expect(store.getSettings().terminalFontSize).toBe(22)

    await writeSettingsText('{}')
    await sync.refresh()

    expect(store.getSettings().terminalFontSize).toBe(defaults.terminalFontSize)
    expect(store.getSettings().theme).toBe('dark')
    expect(store.getSettings().settingsFileLastSeenKeys).toEqual([])
  })

  it('writes through a symlinked settings.json and keeps it a symlink', async (context) => {
    const target = join(home, 'dotfiles', 'orca-settings.json')
    await writeSettingsText(JSON.stringify({ theme: 'dark' }), target)
    await mkdir(join(home, '.orca'), { recursive: true })
    try {
      await symlink(target, filePath)
    } catch {
      context.skip()
    }
    const { sync, store } = await startSync()

    store.updateSettings({ terminalFontSize: 24 })
    await sync.flush()

    expect((await lstat(filePath)).isSymbolicLink()).toBe(true)
    expect(await readJson(target)).toEqual({ theme: 'dark', terminalFontSize: 24 })
  })

  it('treats an empty file as an empty object and writes valid JSON on the next change', async () => {
    await writeSettingsText('')
    const { sync, store } = await startSync()
    expect(sync.getStatus()).toMatchObject({ state: 'active', appliedKeyCount: 0 })

    store.updateSettings({ terminalFontSize: 25 })
    await sync.flush()

    expect(await readJson()).toEqual({ terminalFontSize: 25 })
  })

  it('reports read-only for an unwritable target and keeps the in-app value', async (context) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      context.skip()
    }
    await writeSettingsText(JSON.stringify({ theme: 'dark' }))
    const { sync, store } = await startSync()
    await chmod(filePath, 0o444)
    await chmod(join(home, '.orca'), 0o555)

    store.updateSettings({ terminalFontSize: 26 })
    await sync.flush()

    expect(sync.getStatus().state).toBe('read-only')
    expect(store.getSettings().terminalFontSize).toBe(26)
    expect(await readJson()).toEqual({ theme: 'dark' })
  })

  it('keeps a pending UI value over an external change while applying the other external keys', async () => {
    await writeSettingsText(JSON.stringify({ theme: 'dark' }))
    const { sync, store } = await startSync({}, { debounceMs: 60_000 })

    store.updateSettings({ terminalFontSize: 30 })
    await writeSettingsText(JSON.stringify({ theme: 'light', terminalFontSize: 12 }))
    await sync.refresh()

    expect(store.getSettings().terminalFontSize).toBe(30)
    expect(store.getSettings().theme).toBe('light')

    await sync.flush()
    expect(await readJson()).toEqual({ theme: 'light', terminalFontSize: 30 })
  })

  it('does nothing for an absent file and never creates it on a UI change', async () => {
    const { sync, store } = await startSync()
    expect(sync.getStatus().state).toBe('absent')

    store.updateSettings({ terminalFontSize: 27 })
    await sync.flush()

    expect(existsSync(filePath)).toBe(false)
    expect(sync.getStatus().state).toBe('absent')
  })

  it('creates the file from non-default portable values only on the explicit create action', async () => {
    const { sync, store } = await startSync({ terminalFontSize: 28 })

    const status = await sync.createFromCurrentSettings()

    expect(status).toMatchObject({ state: 'active', appliedKeyCount: 1 })
    expect(await readJson()).toEqual({ terminalFontSize: 28 })
    store.updateSettings({ theme: 'dark' })
    await sync.flush()
    expect(await readJson()).toEqual({ terminalFontSize: 28, theme: 'dark' })
  })

  it('rejects the create action when the file cannot be created', async () => {
    await writeFile(join(home, 'blocker'), '')
    filePath = join(home, 'blocker', 'nested', 'settings.json')
    const { sync } = await startSync({ terminalFontSize: 28 })

    await expect(sync.createFromCurrentSettings()).rejects.toThrow()
    expect(sync.getStatus().state).toBe('absent')
  })

  it('picks up an external edit through the real file watcher', async () => {
    await writeSettingsText(JSON.stringify({ theme: 'dark' }))
    const store = createFakeStore({}, defaults)
    const sync = createSettingsFileSync({
      filePath,
      store,
      defaults,
      log: { info: () => {}, warn: () => {} },
      debounceMs: 5
    })
    active.push(sync)
    await sync.start()
    expect(store.getSettings().theme).toBe('dark')

    await writeSettingsText(JSON.stringify({ theme: 'light' }))

    await vi.waitFor(() => expect(store.getSettings().theme).toBe('light'), { timeout: 8_000 })
  })

  it('keeps the in-app value and read-only status across refreshes until the file content changes', async (context) => {
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      context.skip()
    }
    await writeSettingsText(JSON.stringify({ theme: 'dark' }))
    const { sync, store } = await startSync()
    await chmod(filePath, 0o444)
    await chmod(join(home, '.orca'), 0o555)

    store.updateSettings({ terminalFontSize: 26 })
    await sync.flush()
    expect(sync.getStatus().state).toBe('read-only')

    await sync.refresh()
    expect(store.getSettings().terminalFontSize).toBe(26)
    expect(sync.getStatus().state).toBe('read-only')

    await chmod(join(home, '.orca'), 0o755)
    await chmod(filePath, 0o644)
    await writeSettingsText(JSON.stringify({ theme: 'dark', terminalFontSize: 18 }))
    await chmod(filePath, 0o444)
    await sync.refresh()

    expect(store.getSettings().terminalFontSize).toBe(18)
  })

  it('applies a file that appeared before the create action instead of overwriting it', async () => {
    const { sync, store } = await startSync()
    expect(sync.getStatus().state).toBe('absent')

    await writeSettingsText(JSON.stringify({ terminalFontSize: 31 }))
    const status = await sync.createFromCurrentSettings()

    expect(status).toMatchObject({ state: 'active', appliedKeyCount: 1 })
    expect(store.getSettings().terminalFontSize).toBe(31)
    expect(await readJson()).toEqual({ terminalFontSize: 31 })
  })

  it('reports a dangling symlink as invalid with the link message', async (context) => {
    await mkdir(join(home, '.orca'), { recursive: true })
    try {
      await symlink(join(home, 'nowhere', 'settings.json'), filePath)
    } catch {
      context.skip()
    }
    const { sync } = await startSync()

    expect(sync.getStatus()).toMatchObject({
      state: 'invalid',
      message: 'The settings file link points to a missing file'
    })
  })

  it('reads a file with a byte order mark and keeps the mark when writing back', async () => {
    await writeSettingsText(`\uFEFF${JSON.stringify({ theme: 'dark' })}\n`)
    const { sync, store } = await startSync()
    expect(store.getSettings().theme).toBe('dark')
    expect(sync.getStatus().state).toBe('active')

    store.updateSettings({ terminalFontSize: 29 })
    await sync.flush()

    const text = await readFile(filePath, 'utf-8')
    expect(text.startsWith('\uFEFF')).toBe(true)
    expect(JSON.parse(text.slice(1))).toEqual({ theme: 'dark', terminalFontSize: 29 })
  })

  it('resets a key to its default after an invalid value is followed by removing the key', async () => {
    await writeSettingsText(JSON.stringify({ terminalFontSize: 22 }))
    const { sync, store } = await startSync()
    expect(store.getSettings().terminalFontSize).toBe(22)

    await writeSettingsText(JSON.stringify({ terminalFontSize: 'big' }))
    await sync.refresh()
    expect(store.getSettings().terminalFontSize).toBe(22)

    await writeSettingsText('{}')
    await sync.refresh()

    expect(store.getSettings().terminalFontSize).toBe(defaults.terminalFontSize)
  })

  it('keeps tab indentation and the missing trailing newline when writing back', async () => {
    await writeSettingsText('{\n\t"theme": "dark"\n}')
    const { sync, store } = await startSync()

    store.updateSettings({ terminalFontSize: 33 })
    await sync.flush()

    expect(await readFile(filePath, 'utf-8')).toBe(
      '{\n\t"theme": "dark",\n\t"terminalFontSize": 33\n}'
    )
  })

  it('keeps four-space indentation when writing back', async () => {
    await writeSettingsText('{\n    "theme": "dark"\n}\n')
    const { sync, store } = await startSync()

    store.updateSettings({ terminalFontSize: 34 })
    await sync.flush()

    expect(await readFile(filePath, 'utf-8')).toBe(
      '{\n    "theme": "dark",\n    "terminalFontSize": 34\n}\n'
    )
  })

  it('reports an unknown uiLanguage as invalid and does not apply it', async () => {
    await writeSettingsText(JSON.stringify({ uiLanguage: 'xx' }))
    const { sync, store } = await startSync()

    expect(store.getSettings().uiLanguage).toBe(defaults.uiLanguage)
    expect(sync.getStatus().ignored).toEqual([{ key: 'uiLanguage', reason: 'invalid-value' }])
  })

  it('applies a known uiLanguage', async () => {
    await writeSettingsText(JSON.stringify({ uiLanguage: 'ko' }))
    const { store } = await startSync()

    expect(store.getSettings().uiLanguage).toBe('ko')
  })

  it('picks up a file created after start through the periodic refresh', async () => {
    const { sync, store } = await startSync({}, { refreshIntervalMs: 20 })
    expect(sync.getStatus().state).toBe('absent')

    await writeSettingsText(JSON.stringify({ theme: 'dark' }))

    await vi.waitFor(() => expect(store.getSettings().theme).toBe('dark'))
    expect(sync.getStatus().state).toBe('active')
  })

  it('reports absent and ignores calls after disposal', async () => {
    await writeSettingsText(JSON.stringify({ theme: 'dark' }))
    const { sync, store } = await startSync()
    await sync.dispose()

    store.updateSettings({ terminalFontSize: 35 })
    await sync.flush()
    await sync.refresh()

    expect(sync.getStatus().state).toBe('absent')
    expect(await readJson()).toEqual({ theme: 'dark' })
  })
})
