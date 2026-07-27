import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { OpenCodeHookService, _internals } from './hook-service'

const { isUsableId, toSafeDirName } = _internals

describe('OpenCode hook plugin source', () => {
  it('filters child sessions via parentID lookup before forwarding events', () => {
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('async function isChildSession(client, sessionID)')
    expect(source).toContain('const sessions = await client.session.list();')
    expect(source).toContain('const isChild = !!session?.parentID;')
    expect(source).toContain('if (sessionID && (await isChildSession(client, sessionID))) {')
    expect(source).toContain('return true;')
  })

  it('still accepts an optional opaque plugin context instead of destructuring', () => {
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('export const OrcaOpenCodeStatusPlugin = async (_ctx) => {')
    expect(source).toContain('const client = _ctx?.client;')
  })

  it('resolves hook coords from the endpoint file before falling back to process.env', () => {
    // Why: a forked session freezes the prior Orca's PORT/TOKEN in env; prefer the on-disk endpoint file or it posts to a dead port after restart.
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('function readEndpointFile()')
    expect(source).toContain('process.env.ORCA_AGENT_HOOK_ENDPOINT')
    // Parser accepts both `KEY=VALUE` (Unix) and `set KEY=VALUE` (Windows):
    expect(source).toContain('/^(?:set\\s+)?([A-Z0-9_]+)=(.*)$/')
    expect(source).toContain('function resolveHookCoords()')
    // File takes precedence over env — the whole point of v2:
    expect(source).toContain(
      'port: fileEnv.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT'
    )
    expect(source).toContain(
      'token: fileEnv.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN'
    )
    // post() uses the resolved coords, not a cached-at-startup url:
    expect(source).toContain('const coords = resolveHookCoords();')
    expect(source).toContain('`http://127.0.0.1:${coords.port}/hook/opencode`')
    expect(source).toContain('"X-Orca-Agent-Hook-Token": coords.token')
  })

  it('caches the parsed endpoint file on mtime+size+inode to skip re-reads per post', () => {
    // Why: cache the parse to avoid a read per streamed Part; inode in the key lets renameSync invalidate it even when mtime/size collide.
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('let cachedEndpointKey = "";')
    expect(source).toContain('let cachedEndpointValues = null;')
    expect(source).toContain('const stat = fs.statSync(path);')
    expect(source).toContain('const cacheKey = stat.mtimeMs + ":" + stat.size + ":" + stat.ino;')
    expect(source).toContain('if (cacheKey === cachedEndpointKey && cachedEndpointValues) {')
    expect(source).toContain('return cachedEndpointValues;')
    // Stat failure must invalidate the cache, not lock in stale values:
    expect(source).toContain('cachedEndpointKey = "";')
    expect(source).toContain('cachedEndpointValues = null;')
  })

  it('forwards question.asked as AskUserQuestion so the pane flips to waiting', () => {
    // Why: forward question.asked too (not just permission.asked), else the pane stays "working" while the agent idles on a human reply.
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('if (event.type === "question.asked")')
    expect(source).toContain('await post("AskUserQuestion", event.properties || {});')
  })

  it('forwards sessionID on status and message posts for resume metadata', () => {
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain(
      'await post("MessagePart", { role, text: capMessagePartText(part.text), messageID: part.messageID, sessionID });'
    )
    expect(source).toContain('messageID: pending.messageID,')
    expect(source).toContain('sessionID: pending.sessionID,')
    expect(source).toContain('await setStatus("busy", { sessionID });')
    expect(source.match(/await setStatus\("idle", \{ sessionID \}\);/g) ?? []).toHaveLength(2)
  })

  it('guards endpoint-file parse warnings with a process-lifetime latch', () => {
    // Why: ENOENT is normal pre-install (stay silent), but a bad file would spam stderr per post; latch warns once per process.
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('let warnedBadEndpoint = false;')
    expect(source).toContain('err.code !== "ENOENT"')
    expect(source).toContain('warnedBadEndpoint = true;')
  })
})

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

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-opencode-hooks-'))
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

  afterEach(() => {
    rmSync(join(userDataDir, 'opencode-hooks'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'opencode-config-overlays'), { recursive: true, force: true })
  })

  it('writes a shared OPENCODE_CONFIG_DIR and installs the plugin file', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(daemonSessionId)

    expect(env.OPENCODE_CONFIG_DIR).toBeTruthy()
    expect(env.OPENCODE_CONFIG_DIR).toBe(join(userDataDir, 'opencode-hooks', 'shared'))

    const pluginPath = join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js')
    expect(existsSync(pluginPath)).toBe(true)
    // Sanity-check the file has plugin source, not a stray write.
    const pluginSource = readFileSync(pluginPath, 'utf8')
    expect(pluginSource).toContain('OrcaOpenCodeStatusPlugin')
    expect(pluginSource).toContain('messageID: part.messageID')
  })

  it('clearPty leaves the shared OpenCode config dir off the teardown hot path', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(daemonSessionId)
    const configDir = env.OPENCODE_CONFIG_DIR!
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
    const env = service.buildPtyEnv(plainUuidId)

    expect(env.OPENCODE_CONFIG_DIR).toBe(join(userDataDir, 'opencode-hooks', 'shared'))
    expect(existsSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'))).toBe(
      true
    )

    service.clearPty(plainUuidId)
    expect(existsSync(env.OPENCODE_CONFIG_DIR!)).toBe(true)
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
