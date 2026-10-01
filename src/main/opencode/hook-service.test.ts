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

const { isUsableId, toSafeDirName } = _internals

describe('OpenCode id safety guard', () => {
  it('accepts the daemon-path sessionId shape (worktreeId@@uuid with ::/...)', () => {
    // Why: after #1148 pty.ts mints sessionIds like <worktreeId>@@<uuid> with "::" and a path; the old strict regex rejected every real id.
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
    // Why: the typeof guard is defense-in-depth for any-typed callers; a test keeps a refactor from silently deleting it.
    expect(isUsableId(undefined as unknown as string)).toBe(false)
    expect(isUsableId(null as unknown as string)).toBe(false)
    expect(isUsableId(42 as unknown as string)).toBe(false)
  })

  it('derives a filesystem-safe directory name independent of the raw id', () => {
    const name = toSafeDirName('50c010::/Users/thebr/x/y@@uuid')
    // Pure hex, bounded length — no slashes, colons, or caller content.
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
  // Why: exercise the public surface against a real filesystem so regressions fail loudly (before #1148 daemon-shaped ids silently returned {}).
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
    // Sanity-check the file has plugin source, not a stray write.
    const pluginSource = readFileSync(pluginPath, 'utf8')
    expect(pluginSource).toContain('OrcaOpenCodeStatusPlugin')
    expect(pluginSource).toContain('messageID: part.messageID')
    // Why: OpenCode 2 reports pane lifecycle from each TUI, which loads only plugin directories.
    const tuiEntry = join(
      resolveOpenCodeConfigDirectory(),
      'plugins',
      'orca-opencode-status-tui',
      'tui.js'
    )
    expect(readFileSync(tuiEntry, 'utf8')).toBe(pluginSource)
    const past = new Date('2020-01-01T00:00:00Z')
    utimesSync(tuiEntry, past, past)
    service.buildPtyEnv(daemonSessionId)
    expect(statSync(tuiEntry).mtimeMs).toBe(past.getTime())
  })

  // Why: OpenCode 2 reloads a plugin whose file mtime changed, which restarted status mid-turn.
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

  // Why: OpenCode 2 loads through a file-level symlink (dotfile managers) and stats its target.
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

  // Why: a service that reloads between the two writes must already find the TUI copy and stand down.
  it('writes the TUI copy before the server plugin file', () => {
    const pluginsDir = join(resolveOpenCodeConfigDirectory(), 'plugins')
    const serverPath = join(pluginsDir, 'orca-opencode2-status.js')
    const tuiDir = join(pluginsDir, 'orca-opencode2-status-tui')
    rmSync(serverPath, { recursive: true, force: true })
    rmSync(tuiDir, { recursive: true, force: true })
    // A directory in the server file's place makes that write fail.
    mkdirSync(serverPath, { recursive: true })
    try {
      openCode2HookService.buildPtyEnv(daemonSessionId)
      expect(existsSync(join(tuiDir, 'tui.js'))).toBe(true)
    } finally {
      rmSync(serverPath, { recursive: true, force: true })
      rmSync(tuiDir, { recursive: true, force: true })
    }
  })

  // Why: #22234 — OpenCode 2 installs under the plain `opencode` name, and its loader
  // rejects a default export that only has server(). Asserting the emitted *source* is
  // not enough; the installed file is what the v2 server validates, so load it.
  it('installs a plugin whose default export satisfies both the v1 and v2 loaders', async () => {
    const service = new OpenCodeHookService()
    service.buildPtyEnv(daemonSessionId)

    const pluginPath = join(resolveOpenCodeConfigDirectory(), 'plugins', 'orca-opencode-status.js')
    // Why: a .mjs copy so Node parses the installed file as ESM without a package.json.
    const modulePath = join(userDataDir, `installed-opencode-plugin-${Date.now()}.mjs`)
    writeFileSync(modulePath, readFileSync(pluginPath, 'utf8'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertions below validate the shape this names.
    const module = (await import(pathToFileURL(modulePath).href)) as {
      default?: { id?: unknown; server?: unknown; setup?: unknown }
    }

    expect(module.default?.id).toBe('orca-opencode-status')
    // v1 loader: "must default export an object with server()".
    expect(module.default?.server).toBeTypeOf('function')
    // v2 loader: "Plugin must export a default definition with an id and an effect or setup function."
    expect(module.default?.setup).toBeTypeOf('function')
  })

  // Why: pre-1.4.209 Orca wrote a server()-only plugin into <userData>/opencode-hooks/shared and
  // stopped maintaining it; shells and OpenCode 2 background services still pointing there got
  // "Plugin must export a default definition with an id and an effect or setup function."
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
    // A service loading this dir stands down only when the TUI copy sits beside it.
    expect(
      readFileSync(join(legacyPluginPath, '..', 'orca-opencode-status-tui', 'tui.js'), 'utf8')
    ).toBe(getOpenCodePluginSource())
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
    // Why: a running OpenCode 2 service re-runs its plugin load on every write to a watched plugin file.
    expect(statSync(legacyPluginPath).mtimeMs).toBe(past.getTime())
  })

  // Why: #22506 — both variants install side by side in one global plugins dir, and
  // OpenCode 2 kills every plugin after the first that reuses an id ("Duplicate plugin
  // ID"). Discovery sorts by path, so orca-opencode-status.js always wins and the
  // opencode2 plugin never loads. Assert the installed files, not just the sources.
  it('installs both family plugins into one config dir under distinct ids', async () => {
    expect(new OpenCodeHookService().buildPtyEnv(daemonSessionId)).toEqual({})
    // #22440 Issue 2: the opencode2 variant must not shadow global config discovery either.
    expect(openCode2HookService.buildPtyEnv(daemonSessionId)).toEqual({})

    const pluginsDir = join(resolveOpenCodeConfigDirectory(), 'plugins')
    const ids: string[] = []
    for (const fileName of ['orca-opencode-status.js', 'orca-opencode2-status.js']) {
      // Why: a .mjs copy so Node parses the installed file as ESM without a package.json.
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
    // Why: even when the id is rejected, don't blow away the user's own OPENCODE_CONFIG_DIR.
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
  // Why: with a user-set OPENCODE_CONFIG_DIR, mirror it into an overlay rather than overwrite it (docs/opencode-config-dir-collision.md).
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
    // Realistic user config: top-level files plus a plugins/ dir with a user plugin.
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

    // Mirrored user files reachable via the overlay.
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'opencode.json'), 'utf8')).toBe(
      '{"userTheme":"solarized"}'
    )
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'auth.json'), 'utf8')).toBe(
      'user-auth-token'
    )
    expect(readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'user-plugin.js'), 'utf8')).toBe(
      'export default () => {}'
    )

    // Orca's status plugin is a sibling, not a replacement.
    const orcaPluginPath = join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js')
    expect(existsSync(orcaPluginPath)).toBe(true)
    expect(readFileSync(orcaPluginPath, 'utf8')).toContain('OrcaOpenCodeStatusPlugin')

    expectUserConfigIntact()
  })

  it.skipIf(process.platform === 'win32')(
    'mirrors top-level entries via symlinks so plugins/ is a real directory',
    () => {
      // Why: only plugins/ needs per-entry mirroring (Orca drops a sibling); other entries are single symlinks so user edits propagate live.
      const service = new OpenCodeHookService()
      const env = service.buildPtyEnv(ptyId, userConfigDir)

      const overlay = env.OPENCODE_CONFIG_DIR!
      expect(lstatSync(join(overlay, 'opencode.json')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(overlay, 'auth.json')).isSymbolicLink()).toBe(true)
      // plugins/ must be a real dir in the overlay so Orca can drop its sibling plugin.
      expect(lstatSync(join(overlay, 'plugins')).isDirectory()).toBe(true)
      expect(lstatSync(join(overlay, 'plugins')).isSymbolicLink()).toBe(false)
      // user-plugin.js inside plugins/ is mirrored entry-by-entry.
      expect(lstatSync(join(overlay, 'plugins', 'user-plugin.js')).isSymbolicLink()).toBe(true)
    }
  )

  it("does not overwrite a user plugin file with the same filename as Orca's plugin", () => {
    // Why: a user plugin named orca-opencode-status.js must not be symlinked into the overlay, or writeFileSync would clobber it.
    const userOrcaSentinel = 'USER OWNED ORCA-NAMED PLUGIN — DO NOT CLOBBER'
    writeFileSync(join(userConfigDir, 'plugins', 'orca-opencode-status.js'), userOrcaSentinel)

    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(ptyId, userConfigDir)

    // User's source file must be untouched.
    expect(readFileSync(join(userConfigDir, 'plugins', 'orca-opencode-status.js'), 'utf8')).toBe(
      userOrcaSentinel
    )

    // Overlay copy is Orca's real plugin source, not the user's file.
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
    expect(readFileSync(join(overlayTui, 'tui.js'), 'utf8')).toBe(
      readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'), 'utf8')
    )
    expect(readFileSync(join(userTuiDir, 'tui.js'), 'utf8')).toBe('USER OWNED')
  })

  it.skipIf(process.platform === 'win32')(
    'does not write through a symlinked plugins/ directory into the user filesystem',
    () => {
      // Why: writing Orca's plugin through a symlinked plugins/ would leak into the user's fs (docs/opencode-config-dir-collision.md).
      const realPluginsDir = mkdtempSync(join(tmpdir(), 'orca-real-plugins-'))
      try {
        writeFileSync(join(realPluginsDir, 'real-plugin.js'), 'REAL USER PLUGIN')

        // Swap plugins/ for a symlink to the external "real" dir (dotfiles pattern).
        rmSync(join(userConfigDir, 'plugins'), { recursive: true, force: true })
        symlinkSync(realPluginsDir, join(userConfigDir, 'plugins'), 'dir')

        const service = new OpenCodeHookService()
        const env = service.buildPtyEnv(ptyId, userConfigDir)

        // The user's real filesystem must NOT receive Orca's status plugin.
        expect(existsSync(join(realPluginsDir, 'orca-opencode-status.js'))).toBe(false)
        // Overlay's plugins/ must be a real dir, else writes leak into the user's filesystem.
        expect(lstatSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins')).isSymbolicLink()).toBe(false)
        // Orca's status plugin lands in the overlay only.
        expect(
          existsSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'))
        ).toBe(true)
        // User's real plugin is reachable via the overlay (plugins mirrored entry-by-entry after resolving the symlink target).
        expect(
          readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'real-plugin.js'), 'utf8')
        ).toBe('REAL USER PLUGIN')
      } finally {
        rmSync(realPluginsDir, { recursive: true, force: true })
      }
    }
  )

  it("preserves the user's OPENCODE_CONFIG_DIR when the path does not exist", () => {
    // Why: leave a nonexistent user path alone so OpenCode surfaces the typo instead of Orca silently hiding it.
    const service = new OpenCodeHookService()
    const missingPath = join(tmpdir(), `orca-opencode-nope-${Date.now()}`)
    expect(existsSync(missingPath)).toBe(false)

    const env = service.buildPtyEnv(ptyId, missingPath)
    expect(env).toEqual({ OPENCODE_CONFIG_DIR: missingPath })
    // No overlay was created at the typo path.
    expect(existsSync(missingPath)).toBe(false)
    // No overlay dir under userData either.
    expect(
      existsSync(
        join(userDataDir, 'opencode-config-overlays', toSafeDirName(`source:${missingPath}`))
      )
    ).toBe(false)
  })

  it("preserves the user's OPENCODE_CONFIG_DIR when the mirror step fails", async () => {
    // Why: if mirroring fails (e.g. Windows EPERM), fall back to the user's OPENCODE_CONFIG_DIR so their config still loads.
    const overlayMirror = await import('../pty/overlay-mirror')
    const mirrorSpy = vi.spyOn(overlayMirror, 'mirrorEntry').mockImplementation(() => {
      throw new Error('simulated EPERM on symlink')
    })
    try {
      const service = new OpenCodeHookService()
      const env = service.buildPtyEnv(ptyId, userConfigDir)
      expect(env).toEqual({ OPENCODE_CONFIG_DIR: userConfigDir })
      // Overlay cleanup is deliberately off the fallback path; it may hold OpenCode runtime files on Windows.
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
      // Why: OpenCode may fill the overlay with runtime files; PTY teardown must not recursively delete it on Electron main.
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
      // User config must still exist with all original contents.
      expectUserConfigIntact()
      // The plugins/ dir under the user config is also intact.
      expect(readdirSync(join(userConfigDir, 'plugins'))).toEqual(['user-plugin.js'])
    }
  )

  it('rebuilding the overlay for the same ptyId does not corrupt the user dir', () => {
    // Mirrors daemon cold-restore: rebuilding for the same sessionId must refresh the overlay without symlink-walking into user data.
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
