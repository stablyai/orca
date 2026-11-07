import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeHookEventVersions from '../claude-hook-event-versions'

vi.mock('../claude-hook-event-versions', async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeHookEventVersions>()),
  probeRecentClaudeCliVersion: () => Promise.resolve(claudeVersion)
}))
let claudeVersion: string | null = '2.1.319'
import { syncClaudeCodeThemeConfigDirs } from './claude-code-theme-sync'
import { claudeCodeThemeFromTerminal } from './claude-code-theme'
import { TERMINAL_THEME_CATALOG } from '../../../shared/terminal-themes/terminal-theme-catalog'
import { contrastRatio } from '../../../shared/color/rgba-contrast'
import { parseTerminalColor } from '../../../shared/terminal-themes/terminal-title-contrast'

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

  it('removes the theme key it added when there was none', async () => {
    writeSettings({ model: 'opus' })
    await sync(on)
    await sync(off)
    expect(readSettings()).toEqual({ model: 'opus' })
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

  it('leaves a colorblind or custom theme the user picked alone', async () => {
    writeSettings({ theme: 'dark-daltonized' })
    await sync(on)
    expect(readSettings()).toEqual({ theme: 'dark-daltonized' })
  })

  it('leaves settings alone for a Claude Code without custom themes', async () => {
    claudeVersion = '2.1.118'
    writeSettings({ theme: 'dark' })
    await sync(on)
    claudeVersion = '2.1.319'
    expect(readSettings()).toEqual({ theme: 'dark' })
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

  it('leaves Claude Code alone when its config dir does not exist', async () => {
    rmSync(configDir, { recursive: true })
    await sync(on)
    expect(() => readFileSync(settingsPath)).toThrow()
  })
})

describe('Claude Code theme from the terminal palette', () => {
  it.each(['Solarized Light', 'Solarized Dark', 'Builtin Tango Light', 'Gruvbox Light'])(
    'keeps %s text and hues readable on its background',
    (name) => {
      const palette = TERMINAL_THEME_CATALOG[name]
      const theme = claudeCodeThemeFromTerminal(palette)
      const background = parseTerminalColor(palette.background)
      const ratio = (key: string): number => {
        const color = parseTerminalColor(theme?.overrides[key])
        return color && background ? contrastRatio(color, background) : 0
      }
      expect(ratio('text')).toBeGreaterThanOrEqual(4.5)
      expect(ratio('inactive')).toBeGreaterThanOrEqual(4.5)
      for (const key of ['claude', 'success', 'error', 'warning', 'permission']) {
        expect(ratio(key)).toBeGreaterThanOrEqual(3)
      }
    }
  )
})
