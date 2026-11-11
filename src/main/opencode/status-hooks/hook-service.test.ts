import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setAppEnvironment } from '../../../shared/app-environment'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

import { OpenCodeHookService, openCode2HookService } from './hook-service'
import { getOpenCodePluginSource } from './plugin-source/status-plugin-module-source'
import { resolveOpenCodeConfigDirectory } from '../../../shared/opencode-config-directory'

beforeEach(() => {
  vi.stubEnv('ORCA_OPENCODE_PLUGIN_API', 'v2')
  setAppEnvironment({
    getPath: getPathMock,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})

afterEach(() => vi.unstubAllEnvs())

describe('OpenCodeHookService buildPtyEnv / clearPty round-trip', () => {
  const daemonSessionId =
    '50c010a2-bc8e-4eb1-8847-5812133ad6df::/Users/thebr/ghostx/workspaces/noqa/autoheal@@a1b2c3d4'
  let userDataDir: string
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-opencode-hooks-'))
    process.env.XDG_CONFIG_HOME = userDataDir
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterAll(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
    rmSync(userDataDir, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(join(userDataDir, 'opencode-hooks'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'opencode-config-overlays'), { recursive: true, force: true })
  })

  // OpenCode 2 reloads on mtime changes, resetting status mid-turn.

  // OpenCode 2 stats file-level symlink targets used by dotfile managers.

  // A service reloading between writes must already find the TUI copy and stand down.
  it('writes the TUI copy before the server plugin file', () => {
    const pluginsDir = join(resolveOpenCodeConfigDirectory(), 'plugins')
    const serverPath = join(pluginsDir, 'orca-opencode2-status.js')
    const tuiDir = join(pluginsDir, 'orca-opencode2-status-tui')
    rmSync(serverPath, { recursive: true, force: true })
    rmSync(tuiDir, { recursive: true, force: true })
    mkdirSync(serverPath, { recursive: true })
    try {
      openCode2HookService.buildPtyEnv(daemonSessionId)
      expect(existsSync(join(tuiDir, 'tui.js'))).toBe(true)
    } finally {
      rmSync(serverPath, { recursive: true, force: true })
      rmSync(tuiDir, { recursive: true, force: true })
    }
  })

  it('leaves an up-to-date legacy plugin untouched and never creates the retired dir', () => {
    const legacyDir = join(userDataDir, 'opencode-hooks')
    new OpenCodeHookService().buildPtyEnv(daemonSessionId)
    expect(existsSync(legacyDir)).toBe(false)

    const legacyPluginPath = join(legacyDir, 'shared', 'plugins', 'orca-opencode-status.js')
    mkdirSync(join(legacyPluginPath, '..'), { recursive: true })
    writeFileSync(legacyPluginPath, getOpenCodePluginSource())
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(legacyPluginPath, past, past)
    new OpenCodeHookService().buildPtyEnv(daemonSessionId)
    expect(statSync(legacyPluginPath).mtimeMs).toBe(past.getTime())
  })
})

describe('OpenCodeHookService overlay mode (user OPENCODE_CONFIG_DIR set)', () => {
  const ptyId = 'overlay-pty-1'
  let userDataDir: string
  let userConfigDir: string

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-opencode-overlay-userdata-'))
    getPathMock.mockImplementation((name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected getPath(${name})`)
    })
  })

  afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    userConfigDir = mkdtempSync(join(tmpdir(), 'orca-opencode-overlay-userconfig-'))
    writeFileSync(join(userConfigDir, 'opencode.json'), '{"userTheme":"solarized"}')
    writeFileSync(join(userConfigDir, 'auth.json'), 'user-auth-token')
    mkdirSync(join(userConfigDir, 'plugins'), { recursive: true })
    writeFileSync(join(userConfigDir, 'plugins', 'user-plugin.js'), 'export default () => {}')
  })

  afterEach(() => {
    rmSync(userConfigDir, { recursive: true, force: true })
    rmSync(join(userDataDir, 'opencode-hooks'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'opencode-config-overlays'), { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'does not write through a symlinked plugins/ directory into the user filesystem',
    () => {
      // Writing through a symlinked plugins directory would modify user-owned files.
      const realPluginsDir = mkdtempSync(join(tmpdir(), 'orca-real-plugins-'))
      try {
        writeFileSync(join(realPluginsDir, 'real-plugin.js'), 'REAL USER PLUGIN')

        rmSync(join(userConfigDir, 'plugins'), { recursive: true, force: true })
        symlinkSync(realPluginsDir, join(userConfigDir, 'plugins'), 'dir')

        const service = new OpenCodeHookService()
        const env = service.buildPtyEnv(ptyId, userConfigDir)

        expect(existsSync(join(realPluginsDir, 'orca-opencode-status.js'))).toBe(false)
        expect(lstatSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins')).isSymbolicLink()).toBe(false)
        expect(
          existsSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'))
        ).toBe(true)
        expect(
          readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'real-plugin.js'), 'utf8')
        ).toBe('REAL USER PLUGIN')
      } finally {
        rmSync(realPluginsDir, { recursive: true, force: true })
      }
    }
  )

  it('reconciles stale mirrored entries while preserving OpenCode runtime files', () => {
    const service = new OpenCodeHookService()
    const firstEnv = service.buildPtyEnv(ptyId, userConfigDir)
    const overlayDir = firstEnv.OPENCODE_CONFIG_DIR!

    mkdirSync(join(overlayDir, 'node_modules', 'opencode-runtime'), { recursive: true })
    writeFileSync(join(overlayDir, 'node_modules', 'opencode-runtime', 'index.js'), '')

    rmSync(join(userConfigDir, 'auth.json'), { force: true })
    writeFileSync(join(userConfigDir, 'auth.json'), 'rotated-user-auth-token')
    rmSync(join(userConfigDir, 'plugins', 'user-plugin.js'), { force: true })
    writeFileSync(join(userConfigDir, 'plugins', 'new-plugin.js'), 'export default "new"')

    const secondEnv = service.buildPtyEnv(ptyId, userConfigDir)

    expect(secondEnv.OPENCODE_CONFIG_DIR).toBe(overlayDir)
    expect(readFileSync(join(overlayDir, 'auth.json'), 'utf8')).toBe('rotated-user-auth-token')
    expect(existsSync(join(overlayDir, 'plugins', 'user-plugin.js'))).toBe(false)
    expect(readFileSync(join(overlayDir, 'plugins', 'new-plugin.js'), 'utf8')).toBe(
      'export default "new"'
    )
    expect(existsSync(join(overlayDir, 'node_modules', 'opencode-runtime', 'index.js'))).toBe(true)
  })
})
