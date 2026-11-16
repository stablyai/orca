import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeHookEventVersions from '../cli-capabilities/claude-hook-event-versions'

vi.mock('../cli-capabilities/claude-hook-event-versions', async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeHookEventVersions>()),
  probeRecentClaudeCliVersion: () => Promise.resolve(claudeVersion)
}))
let claudeVersion: string | null = '2.1.319'
import { syncClaudeCodeThemeConfigDirs } from './claude-code-theme-sync'
import './claude-code-theme'
import '../../../shared/terminal-themes/terminal-theme-catalog'
import '../../../shared/color/rgba-contrast'
import '../../../shared/terminal-themes/terminal-title-contrast'

const THEME = { name: 'Orca', base: 'dark', overrides: { claude: '#7aa2f7' } }
const on = { enabled: true, theme: THEME } as const
const off = { enabled: false, terminalBase: 'dark' } as const

describe('Claude Code theme sync', () => {
  let home: string
  let configDir: string
  let settingsPath: string
  const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf-8'))
  const writeSettings = (value: unknown) => writeFileSync(settingsPath, JSON.stringify(value))
  const sync = (target: typeof on | typeof off) =>
    syncClaudeCodeThemeConfigDirs(target, join(home, 'userData'))

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-claude-theme-sync-'))
    configDir = join(home, 'claude-config')
    settingsPath = join(configDir, 'settings.json')
    mkdirSync(configDir)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('selects the Orca theme beside the user keys and restores the replaced theme', async () => {
    writeSettings({ theme: 'light', hooks: { Stop: [] } })
    await sync(on)
    expect(readSettings()).toEqual({ theme: 'custom:orca', hooks: { Stop: [] } })
    expect(JSON.parse(readFileSync(join(configDir, 'themes', 'orca.json'), 'utf-8'))).toEqual(THEME)

    await sync(off)
    expect(readSettings()).toEqual({ theme: 'light', hooks: { Stop: [] } })
    // Running sessions keep reading the file, so it takes the restored look.
    expect(JSON.parse(readFileSync(join(configDir, 'themes', 'orca.json'), 'utf-8'))).toEqual({
      name: 'Orca',
      base: 'light',
      overrides: {}
    })
  })

  it('stops writing once the user picks another theme, and leaves it on disable', async () => {
    writeSettings({ theme: 'dark' })
    await sync(on)
    writeSettings({ theme: 'light-daltonized' })
    await sync(on)
    await sync(on)
    expect(readSettings()).toEqual({ theme: 'light-daltonized' })
    await sync(off)
    expect(readSettings()).toEqual({ theme: 'light-daltonized' })
  })

  it.skipIf(process.platform === 'win32')(
    'takes over later when the settings write fails, instead of treating it as the user’s pick',
    async () => {
      writeSettings({ theme: 'dark' })
      mkdirSync(join(configDir, 'themes'))
      chmodSync(configDir, 0o555)
      try {
        await sync(on)
      } finally {
        chmodSync(configDir, 0o755)
      }
      expect(readSettings()).toEqual({ theme: 'dark' })
      await sync(on)
      expect(readSettings()).toEqual({ theme: 'custom:orca' })
    }
  )

  it('never rewrites a settings file it cannot parse', async () => {
    writeFileSync(settingsPath, '{ "theme": "dark", ')
    await sync(on)
    expect(readFileSync(settingsPath, 'utf-8')).toBe('{ "theme": "dark", ')
  })
})
