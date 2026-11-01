import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  openSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setAppEnvironment } from '../../shared/app-environment'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

import {
  OpenCodeHookService,
  openCode2HookService,
  _internals,
  getOpenCodePluginSource
} from './hook-service'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'

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

const { isUsableId, toSafeDirName } = _internals

describe('OpenCode id safety guard', () => {
  it('accepts the daemon-path sessionId shape (worktreeId@@uuid with ::/...)', () => {
    const daemonSessionId =
      '50c010a2-bc8e-4eb1-8847-5812133ad6df::/Users/thebr/ghostx/workspaces/noqa/autoheal@@a1b2c3d4'
    expect(isUsableId(daemonSessionId)).toBe(true)
  })

  it('accepts ids at the inclusive upper length bound', () => {
    expect(isUsableId('x'.repeat(1024))).toBe(true)
  })

  it('rejects empty or oversized ids', () => {
    expect(isUsableId('')).toBe(false)
    expect(isUsableId('x'.repeat(1025))).toBe(false)
  })

  it('rejects non-string runtime values even though the type says string', () => {
    expect(isUsableId(undefined as unknown as string)).toBe(false)
    expect(isUsableId(null as unknown as string)).toBe(false)
    expect(isUsableId(42 as unknown as string)).toBe(false)
  })

  it('derives a filesystem-safe directory name independent of the raw id', () => {
    const name = toSafeDirName('50c010::/Users/thebr/x/y@@uuid')
    expect(name).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is stable across calls for the same id', () => {
    const id = 'some-session-id'
    expect(toSafeDirName(id)).toBe(toSafeDirName(id))
  })

  it('produces different names for different ids', () => {
    expect(toSafeDirName('a')).not.toBe(toSafeDirName('b'))
  })
})

describe('OpenCodeHookService buildPtyEnv / clearPty round-trip', () => {
  const daemonSessionId =
    '50c010a2-bc8e-4eb1-8847-5812133ad6df::/Users/thebr/ghostx/workspaces/noqa/autoheal@@a1b2c3d4'
  const plainUuidId = 'c0ffee00-0000-4000-8000-000000000000'
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

  it('installs the plugin without overriding OpenCode config discovery', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(daemonSessionId)

    expect(env).toEqual({})
    const pluginPath = join(resolveOpenCodeConfigDirectory(), 'plugins', 'orca-opencode-status.js')
    expect(existsSync(pluginPath)).toBe(true)
    const pluginSource = readFileSync(pluginPath, 'utf8')
    expect(pluginSource).toContain('messageID: part.messageID')
    const tuiEntry = join(
      resolveOpenCodeConfigDirectory(),
      'plugins',
      'orca-opencode-status-tui',
      'tui.js'
    )
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(tuiEntry, past, past)
    service.buildPtyEnv(daemonSessionId)
    expect(statSync(tuiEntry).mtimeMs).toBe(past.getTime())
  })

  // OpenCode 2 reloads on mtime changes, resetting status mid-turn.
  it('leaves a current installed plugin untouched and replaces a stale one', () => {
    const service = new OpenCodeHookService()
    service.buildPtyEnv(daemonSessionId)
    const pluginPath = join(resolveOpenCodeConfigDirectory(), 'plugins', 'orca-opencode-status.js')
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(pluginPath, past, past)

    service.buildPtyEnv(daemonSessionId)
    expect(statSync(pluginPath).mtimeMs).toBe(past.getTime())

    writeFileSync(pluginPath, 'stale plugin')
    service.buildPtyEnv(daemonSessionId)
    expect(readFileSync(pluginPath, 'utf8')).toBe(_internals.getOpenCodePluginSource())
  })

  // OpenCode 2 stats file-level symlink targets used by dotfile managers.
  it.skipIf(process.platform === 'win32')(
    'compares a symlinked plugin by its target and writes through only when stale',
    () => {
      const service = new OpenCodeHookService()
      const pluginPath = join(
        resolveOpenCodeConfigDirectory(),
        'plugins',
        'orca-opencode-status.js'
      )
      const targetPath = join(userDataDir, 'dotfiles-orca-opencode-status.js')
      writeFileSync(targetPath, _internals.getOpenCodePluginSource())
      rmSync(pluginPath, { force: true })
      symlinkSync(targetPath, pluginPath)
      const past = new Date('2020-01-01T00:00:00Z')
      utimesSync(targetPath, past, past)

      service.buildPtyEnv(daemonSessionId)
      expect(statSync(targetPath).mtimeMs).toBe(past.getTime())

      writeFileSync(targetPath, 'stale plugin')
      service.buildPtyEnv(daemonSessionId)
      expect(lstatSync(pluginPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(targetPath, 'utf8')).toBe(_internals.getOpenCodePluginSource())
      rmSync(pluginPath, { force: true })
      rmSync(targetPath, { force: true })
    }
  )

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

  it('installs a plugin whose default export satisfies both the v1 and v2 loaders', async () => {
    const service = new OpenCodeHookService()
    service.buildPtyEnv(daemonSessionId)

    const pluginPath = join(resolveOpenCodeConfigDirectory(), 'plugins', 'orca-opencode-status.js')
    // Use .mjs to load installed ESM without a package.json.
    const modulePath = join(userDataDir, `installed-opencode-plugin-${Date.now()}.mjs`)
    writeFileSync(modulePath, readFileSync(pluginPath, 'utf8'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertions below validate the shape this names.
    const module = (await import(pathToFileURL(modulePath).href)) as {
      default?: { id?: unknown; server?: unknown; setup?: unknown }
    }

    expect(module.default?.id).toBe('orca-opencode-status')
    expect(module.default?.server).toBeTypeOf('function')
    expect(module.default?.setup).toBeTypeOf('function')
  })

  // Pre-1.4.209 installs left server-only plugins in this retired but still-used directory.
  it('refreshes a stale plugin left in the retired shared hooks dir', async () => {
    const legacyPluginPath = join(
      userDataDir,
      'opencode-hooks',
      'shared',
      'plugins',
      'orca-opencode-status.js'
    )
    mkdirSync(join(legacyPluginPath, '..'), { recursive: true })
    writeFileSync(
      legacyPluginPath,
      'export default { id: "orca-opencode-status", server: async () => ({}) };\n'
    )

    new OpenCodeHookService().buildPtyEnv(daemonSessionId)

    const modulePath = join(userDataDir, `legacy-opencode-plugin-${Date.now()}.mjs`)
    writeFileSync(modulePath, readFileSync(legacyPluginPath, 'utf8'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertions below validate the shape this names.
    const module = (await import(pathToFileURL(modulePath).href)) as {
      default?: { id?: unknown; server?: unknown; setup?: unknown }
    }
    expect(module.default?.id).toBe('orca-opencode-status')
    expect(module.default?.server).toBeTypeOf('function')
    expect(module.default?.setup).toBeTypeOf('function')
    // Services stand down only when their TUI copy exists alongside them.
    expect(
      readFileSync(join(legacyPluginPath, '..', 'orca-opencode-status-tui', 'tui.js'), 'utf8')
    ).toContain('tui: setupLegacyOpenCodeTui')
  })

  it('repairs late and overwritten legacy plugins atomically on the same service', () => {
    const service = new OpenCodeHookService()
    service.refreshLegacySharedPlugin()
    const path = join(userDataDir, 'opencode-hooks', 'shared', 'plugins', 'orca-opencode-status.js')
    mkdirSync(join(path, '..'), { recursive: true })
    for (const stale of ['// late old install', '// old process overwrote repair']) {
      writeFileSync(path, stale)
      const reader = openSync(path, 'r')
      try {
        service.refreshLegacySharedPlugin()
        expect(readFileSync(path, 'utf8')).toBe(getOpenCodePluginSource())
        expect(readFileSync(reader, 'utf8')).toBe(stale)
        expect(readdirSync(join(path, '..')).sort()).toEqual([
          'orca-opencode-status-tui',
          'orca-opencode-status.js'
        ])
      } finally {
        closeSync(reader)
      }
    }
  })

  it('reports repair failures and retries after the obstruction is removed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const path = join(userDataDir, 'opencode-hooks', 'shared', 'plugins', 'orca-opencode-status.js')
    const service = new OpenCodeHookService()
    try {
      service.refreshLegacySharedPlugin()
      expect(warn).not.toHaveBeenCalled()
      mkdirSync(path, { recursive: true })
      service.refreshLegacySharedPlugin()
      expect(warn).toHaveBeenCalledWith(
        '[OpenCode] Failed to repair legacy status plugin:',
        path,
        expect.any(Error)
      )
      rmSync(path, { recursive: true })
      writeFileSync(path, '// stale')
      service.refreshLegacySharedPlugin()
      expect(readFileSync(path, 'utf8')).toBe(getOpenCodePluginSource())
    } finally {
      warn.mockRestore()
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

  // OpenCode 2 disables later plugins with duplicate IDs; verify installed artifacts.
  it('installs both family plugins into one config dir under distinct ids', async () => {
    expect(new OpenCodeHookService().buildPtyEnv(daemonSessionId)).toEqual({})
    expect(openCode2HookService.buildPtyEnv(daemonSessionId)).toEqual({})

    const pluginsDir = join(resolveOpenCodeConfigDirectory(), 'plugins')
    const ids: string[] = []
    for (const fileName of ['orca-opencode-status.js', 'orca-opencode2-status.js']) {
      // Use .mjs to load installed ESM without a package.json.
      const modulePath = join(userDataDir, `installed-${fileName}-${Date.now()}.mjs`)
      writeFileSync(modulePath, readFileSync(join(pluginsDir, fileName), 'utf8'))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertions below validate the shape this names.
      const module = (await import(pathToFileURL(modulePath).href)) as {
        default?: { id?: unknown }
      }
      ids.push(String(module.default?.id))
    }

    expect(ids).toEqual(['orca-opencode-status', 'orca-opencode2-status'])
  })

  it('clearPty leaves the shared OpenCode config dir off the teardown hot path', () => {
    const service = new OpenCodeHookService()
    service.buildPtyEnv(daemonSessionId)
    const configDir = resolveOpenCodeConfigDirectory()
    expect(existsSync(configDir)).toBe(true)
    mkdirSync(join(configDir, 'node_modules', 'opencode-runtime'), { recursive: true })
    writeFileSync(join(configDir, 'node_modules', 'opencode-runtime', 'index.js'), '')

    service.clearPty(daemonSessionId)
    expect(existsSync(configDir)).toBe(true)
    expect(existsSync(join(configDir, 'node_modules', 'opencode-runtime', 'index.js'))).toBe(true)
  })

  it('buildPtyEnv returns {} for an unusable id and creates nothing on disk', () => {
    const service = new OpenCodeHookService()
    const hooksRoot = join(userDataDir, 'opencode-hooks')
    const overlaysRoot = join(userDataDir, 'opencode-config-overlays')

    expect(service.buildPtyEnv('')).toEqual({})
    expect(existsSync(hooksRoot)).toBe(false)
    expect(existsSync(overlaysRoot)).toBe(false)
  })

  it('buildPtyEnv preserves a user-set OPENCODE_CONFIG_DIR when the id is unusable', () => {
    const service = new OpenCodeHookService()
    const userDir = mkdtempSync(join(tmpdir(), 'orca-opencode-userdir-'))
    try {
      expect(service.buildPtyEnv('', userDir)).toEqual({ OPENCODE_CONFIG_DIR: userDir })
    } finally {
      rmSync(userDir, { recursive: true, force: true })
    }
  })

  it('works end-to-end for a plain UUID id (non-daemon path)', () => {
    const service = new OpenCodeHookService()
    service.buildPtyEnv(plainUuidId)

    const configDir = resolveOpenCodeConfigDirectory()
    expect(existsSync(join(configDir, 'plugins', 'orca-opencode-status.js'))).toBe(true)

    service.clearPty(plainUuidId)
    expect(existsSync(configDir)).toBe(true)
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

  function expectUserConfigIntact(): void {
    expect(readFileSync(join(userConfigDir, 'opencode.json'), 'utf8')).toBe(
      '{"userTheme":"solarized"}'
    )
    expect(readFileSync(join(userConfigDir, 'auth.json'), 'utf8')).toBe('user-auth-token')
    expect(readFileSync(join(userConfigDir, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )
  }

  it('builds an overlay under userData and exposes user config + Orca plugin together', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(ptyId, userConfigDir)

    expect(env.OPENCODE_CONFIG_DIR).toBe(
      join(userDataDir, 'opencode-config-overlays', toSafeDirName(`source:${userConfigDir}`))
    )
    expect(env.OPENCODE_CONFIG_DIR).not.toBe(userConfigDir)

    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'opencode.json'), 'utf8')).toBe(
      '{"userTheme":"solarized"}'
    )
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'auth.json'), 'utf8')).toBe(
      'user-auth-token'
    )
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )

    const orcaPluginPath = join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js')
    expect(existsSync(orcaPluginPath)).toBe(true)
    expect(readFileSync(orcaPluginPath, 'utf8')).toContain('OrcaOpenCodeStatusPlugin')

    expectUserConfigIntact()
  })

  it.skipIf(process.platform === 'win32')(
    'mirrors top-level entries via symlinks so plugins/ is a real directory',
    () => {
      // Only plugins needs per-entry links; other links preserve live user edits.
      const service = new OpenCodeHookService()
      const env = service.buildPtyEnv(ptyId, userConfigDir)

      const overlay = env.OPENCODE_CONFIG_DIR!
      expect(lstatSync(join(overlay, 'opencode.json')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(overlay, 'auth.json')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(overlay, 'plugins')).isDirectory()).toBe(true)
      expect(lstatSync(join(overlay, 'plugins')).isSymbolicLink()).toBe(false)
      expect(lstatSync(join(overlay, 'plugins', 'user-plugin.js')).isSymbolicLink()).toBe(true)
    }
  )

  it("does not overwrite a user plugin file with the same filename as Orca's plugin", () => {
    // Mirroring this filename would let plugin installation overwrite the user’s file.
    const userOrcaSentinel = 'USER OWNED ORCA-NAMED PLUGIN — DO NOT CLOBBER'
    writeFileSync(join(userConfigDir, 'plugins', 'orca-opencode-status.js'), userOrcaSentinel)

    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(ptyId, userConfigDir)

    expect(readFileSync(join(userConfigDir, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe(
      userOrcaSentinel
    )

    const overlayPlugin = readFileSync(
      join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'),
      'utf8'
    )
    expect(overlayPlugin).toContain('OrcaOpenCodeStatusPlugin')
    expect(overlayPlugin).not.toBe(userOrcaSentinel)
    expectUserConfigIntact()
  })

  it('installs the TUI copy in the overlay without mirroring a user dir of the same name', () => {
    const userTuiDir = join(userConfigDir, 'plugins', 'orca-opencode-status-tui')
    mkdirSync(userTuiDir)
    writeFileSync(join(userTuiDir, 'tui.js'), 'USER OWNED')

    const env = new OpenCodeHookService().buildPtyEnv(ptyId, userConfigDir)

    const overlayTui = join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status-tui')
    expect(lstatSync(overlayTui).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(overlayTui, 'tui.js'), 'utf8')).toContain(
      'tui: setupLegacyOpenCodeTui'
    )
    expect(readFileSync(join(overlayTui, 'tui.js'), 'utf8')).toContain(
      'setup: setupOpenCode2Status'
    )
    expect(readFileSync(join(userTuiDir, 'tui.js'), 'utf8')).toBe('USER OWNED')
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

  it("preserves the user's OPENCODE_CONFIG_DIR when the path does not exist", () => {
    // Preserve typo paths so OpenCode reports them instead of silently hiding user config.
    const service = new OpenCodeHookService()
    const missingPath = join(tmpdir(), `orca-opencode-nope-${Date.now()}`)
    expect(existsSync(missingPath)).toBe(false)

    const env = service.buildPtyEnv(ptyId, missingPath)
    expect(env).toEqual({ OPENCODE_CONFIG_DIR: missingPath })
    expect(existsSync(missingPath)).toBe(false)
    expect(
      existsSync(
        join(userDataDir, 'opencode-config-overlays', toSafeDirName(`source:${missingPath}`))
      )
    ).toBe(false)
  })

  it("preserves the user's OPENCODE_CONFIG_DIR when the mirror step fails", async () => {
    const overlayMirror = await import('../pty/overlay-mirror')
    const mirrorSpy = vi.spyOn(overlayMirror, 'mirrorEntry').mockImplementation(() => {
      throw new Error('simulated EPERM on symlink')
    })
    try {
      const service = new OpenCodeHookService()
      const env = service.buildPtyEnv(ptyId, userConfigDir)
      expect(env).toEqual({ OPENCODE_CONFIG_DIR: userConfigDir })
      // Fallback overlays may contain live Windows runtime files; defer cleanup.
      const overlayDir = join(
        userDataDir,
        'opencode-config-overlays',
        toSafeDirName(`source:${userConfigDir}`)
      )
      expect(existsSync(overlayDir)).toBe(true)
      expectUserConfigIntact()
    } finally {
      mirrorSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'clearPty leaves the source overlay off the teardown hot path',
    () => {
      // Runtime files can make recursive overlay deletion block Electron main.
      const service = new OpenCodeHookService()
      service.buildPtyEnv(ptyId, userConfigDir)

      const overlayDir = join(
        userDataDir,
        'opencode-config-overlays',
        toSafeDirName(`source:${userConfigDir}`)
      )
      expect(existsSync(overlayDir)).toBe(true)

      service.clearPty(ptyId)

      expect(existsSync(overlayDir)).toBe(true)
      expectUserConfigIntact()
      expect(readdirSync(join(userConfigDir, 'plugins'))).toEqual(['user-plugin.js'])
    }
  )

  it('rebuilding the overlay for the same ptyId does not corrupt the user dir', () => {
    const service = new OpenCodeHookService()
    service.buildPtyEnv(ptyId, userConfigDir)
    service.buildPtyEnv(ptyId, userConfigDir)
    const env = service.buildPtyEnv(ptyId, userConfigDir)

    expect(
      readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'), 'utf8')
    ).toContain('OrcaOpenCodeStatusPlugin')
    expectUserConfigIntact()
  })

  it('leaves a current overlay plugin file in place across spawns', () => {
    const service = new OpenCodeHookService()
    const overlayDir = service.buildPtyEnv(ptyId, userConfigDir).OPENCODE_CONFIG_DIR!
    const pluginPath = join(overlayDir, 'plugins', 'orca-opencode-status.js')
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(pluginPath, past, past)

    service.buildPtyEnv(ptyId, userConfigDir)

    expect(statSync(pluginPath).mtimeMs).toBe(past.getTime())
    expect(readFileSync(pluginPath, 'utf8')).toBe(_internals.getOpenCodePluginSource())
  })

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
