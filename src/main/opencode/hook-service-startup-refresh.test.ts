import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../shared/app-environment'
import { OpenCodeHookService, openCode2HookService, getOpenCode2PluginSource } from './hook-service'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'

const PLUGIN = 'orca-opencode2-status.js'
const TUI_ENTRY = join('orca-opencode2-status-tui', 'tui.js')

describe('OpenCodeHookService.refreshInstalledPlugins (app start)', () => {
  let userDataDir: string
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-opencode-startup-refresh-'))
    process.env.XDG_CONFIG_HOME = join(userDataDir, 'xdg')
  })

  beforeEach(() => {
    setAppEnvironment({
      getPath: (name: string) => {
        if (name === 'userData') {
          return userDataDir
        }
        throw new Error(`unexpected getPath(${name})`)
      },
      getAppPath: () => process.cwd(),
      getVersion: () => '0.0.0-test',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
  })

  afterEach(() => {
    rmSync(join(userDataDir, 'xdg'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'opencode2-config-overlays'), { recursive: true, force: true })
  })

  afterAll(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
    rmSync(userDataDir, { recursive: true, force: true })
  })

  // Why: QA saw an upgraded app keep a running service on the old plugin until any pane opened.
  it('upgrades an existing install, TUI copy included, so a running service reloads it', () => {
    const pluginsDir = join(resolveOpenCodeConfigDirectory(), 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(join(pluginsDir, PLUGIN), '// plugin from the previous Orca release')

    openCode2HookService.refreshInstalledPlugins()

    expect(readFileSync(join(pluginsDir, PLUGIN), 'utf8')).toBe(getOpenCode2PluginSource())
    expect(readFileSync(join(pluginsDir, TUI_ENTRY), 'utf8')).toBe(getOpenCode2PluginSource())
  })

  it('never creates an install the user did not already have', () => {
    openCode2HookService.refreshInstalledPlugins()

    expect(existsSync(resolveOpenCodeConfigDirectory())).toBe(false)
    expect(existsSync(join(userDataDir, 'opencode2-config-overlays'))).toBe(false)
  })

  it('leaves a current install untouched so nothing reloads', () => {
    const pluginsDir = join(resolveOpenCodeConfigDirectory(), 'plugins')
    mkdirSync(join(pluginsDir, 'orca-opencode2-status-tui'), { recursive: true })
    writeFileSync(join(pluginsDir, PLUGIN), getOpenCode2PluginSource())
    writeFileSync(join(pluginsDir, TUI_ENTRY), getOpenCode2PluginSource())
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(pluginsDir, PLUGIN), past, past)
    utimesSync(join(pluginsDir, TUI_ENTRY), past, past)

    openCode2HookService.refreshInstalledPlugins()

    expect(statSync(join(pluginsDir, PLUGIN)).mtimeMs).toBe(past.getTime())
    expect(statSync(join(pluginsDir, TUI_ENTRY)).mtimeMs).toBe(past.getTime())
  })

  it('upgrades existing source overlays and skips overlays without Orca plugin', () => {
    const overlays = join(userDataDir, 'opencode2-config-overlays')
    const stale = join(overlays, 'stale', 'plugins')
    const foreign = join(overlays, 'foreign', 'plugins')
    mkdirSync(stale, { recursive: true })
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(stale, PLUGIN), '// plugin from the previous Orca release')

    openCode2HookService.refreshInstalledPlugins()

    expect(readFileSync(join(stale, PLUGIN), 'utf8')).toBe(getOpenCode2PluginSource())
    expect(readFileSync(join(stale, TUI_ENTRY), 'utf8')).toBe(getOpenCode2PluginSource())
    expect(existsSync(join(foreign, PLUGIN))).toBe(false)
  })

  it('keeps refreshing other installs when one write fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new OpenCodeHookService({
      pluginFileName: PLUGIN,
      legacyHooksDir: 'opencode2-hooks',
      overlayDir: 'opencode2-config-overlays',
      pluginSource: () => '// next release',
      installsTuiPlugin: true
    })
    const pluginsDir = join(resolveOpenCodeConfigDirectory(), 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(join(pluginsDir, PLUGIN), '// old')
    // A file where the TUI copy's directory belongs makes the config-dir write fail.
    writeFileSync(join(pluginsDir, 'orca-opencode2-status-tui'), 'obstruction')
    const overlayPlugins = join(userDataDir, 'opencode2-config-overlays', 'a', 'plugins')
    mkdirSync(overlayPlugins, { recursive: true })
    writeFileSync(join(overlayPlugins, PLUGIN), '// old')

    service.refreshInstalledPlugins()

    expect(readFileSync(join(overlayPlugins, PLUGIN), 'utf8')).toBe('// next release')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
