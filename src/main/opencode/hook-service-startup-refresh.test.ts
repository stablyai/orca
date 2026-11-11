import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../shared/app-environment'
import { OpenCodeHookService } from './hook-service'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'

const PLUGIN = 'orca-opencode2-status.js'

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
