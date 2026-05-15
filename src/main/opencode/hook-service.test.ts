/* eslint-disable max-lines -- Why: this suite covers four orthogonal regimes
   (plugin source, id guards, legacy per-PTY round-trip, and overlay mode for
   user-set OPENCODE_CONFIG_DIR). Splitting them across files would scatter
   tightly coupled fixtures (userData mock, hooks/overlay roots) and obscure
   the docs/opencode-config-dir-collision.md regression matrix. */
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
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
    // Why: a long-running OpenCode session was fork()ed with the prior Orca's
    // PORT/TOKEN frozen into process.env. The plugin must prefer the on-disk
    // endpoint file (rewritten on every Orca start()) over env, otherwise it
    // keeps posting to a dead port after an Orca restart.
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
    // Why: message.part.updated fires many times per second during a streaming
    // assistant reply. Each post() calls resolveHookCoords() which reads the
    // endpoint file — without the cache we'd readFileSync + parse on every
    // streamed Part. The cache key combines mtime + size + inode so renameSync
    // (writeEndpointFile's atomic swap) invalidates the cache via the ino
    // change even when mtime resolution is coarse and size happens to match.
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
    // Why: OpenCode exposes two separate plugin events for human-in-the-loop
    // moments — `permission.asked` (blocks on tool approval) and
    // `question.asked` (the agent called an ask-the-user tool). The plugin
    // must forward both so the server-side normalizer can map each to
    // `waiting` and render the red indicator. Dropping `question.asked`
    // leaves the pane stuck in `working` while the agent is actually idle,
    // waiting on a human reply — exactly the bug other OpenCode integrations
    // also handle.
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('if (event.type === "question.asked")')
    expect(source).toContain('await post("AskUserQuestion", event.properties || {});')
  })

  it('guards endpoint-file parse warnings with a process-lifetime latch', () => {
    // Why: ENOENT is the normal pre-install case and must stay silent, but a
    // malformed/unreadable file (EACCES, EIO, parse error) would otherwise
    // spam stderr once per hook post. The latch keeps the warning to once per
    // OpenCode process — mirrors server.ts's warnedVersions/warnedEnvs intent.
    const source = _internals.getOpenCodePluginSource()

    expect(source).toContain('let warnedBadEndpoint = false;')
    expect(source).toContain('err.code !== "ENOENT"')
    expect(source).toContain('warnedBadEndpoint = true;')
  })
})

describe('OpenCode id safety guard', () => {
  it('accepts the daemon-path sessionId shape (worktreeId@@uuid with ::/...)', () => {
    // Why: after the daemon-parity refactor (#1148) pty.ts mints sessionIds
    // like `<worktreeId>@@<uuid>` where worktreeId contains "::" and a
    // filesystem path. The previous strict regex rejected every real id and
    // silently dropped OPENCODE_CONFIG_DIR. Lock in that such ids are now
    // accepted so the plugin dir is actually written.
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
    // Why: the typeof guard is defense-in-depth for any-typed callers;
    // without a test, a future refactor could delete the guard silently.
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
  // Why: the primitives above only prove the helpers work in isolation. This
  // suite exercises the public surface against a real filesystem so a future
  // regression — e.g. re-tightening the id guard or desyncing the path used by
  // writeLegacyPluginConfig vs clearPty — fails loudly. Before #1148 the service
  // silently returned {} for daemon-shaped ids; these tests lock that in.
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

  it('writes OPENCODE_CONFIG_DIR for a daemon-shaped sessionId and installs the plugin file', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(daemonSessionId)

    expect(env.OPENCODE_CONFIG_DIR).toBeTruthy()
    expect(env.OPENCODE_CONFIG_DIR).toBe(
      join(userDataDir, 'opencode-hooks', toSafeDirName(daemonSessionId))
    )

    const pluginPath = join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js')
    expect(existsSync(pluginPath)).toBe(true)
    // Sanity-check the file has plugin source, not a stray write.
    expect(readFileSync(pluginPath, 'utf8')).toContain('OrcaOpenCodeStatusPlugin')
  })

  it('clearPty removes the same directory buildPtyEnv created', () => {
    const service = new OpenCodeHookService()
    const env = service.buildPtyEnv(daemonSessionId)
    const configDir = env.OPENCODE_CONFIG_DIR!
    expect(existsSync(configDir)).toBe(true)

    service.clearPty(daemonSessionId)
    expect(existsSync(configDir)).toBe(false)
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
    // Why: defense-in-depth — if the bounds guard rejects the id, we still
    // must not blow away the user's own OPENCODE_CONFIG_DIR. The status
    // plugin is forfeited, but the user's plugins/auth/keymap keep loading.
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

    expect(env.OPENCODE_CONFIG_DIR).toBe(
      join(userDataDir, 'opencode-hooks', toSafeDirName(plainUuidId))
    )
    expect(existsSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'))).toBe(
      true
    )

    service.clearPty(plainUuidId)
    expect(existsSync(env.OPENCODE_CONFIG_DIR!)).toBe(false)
  })
})

describe('OpenCodeHookService overlay mode (user OPENCODE_CONFIG_DIR set)', () => {
  // Why: locks in docs/opencode-config-dir-collision.md — when the user has
  // their own OPENCODE_CONFIG_DIR (e.g. a company-wide opencode config repo),
  // Orca must mirror it into a per-PTY overlay rather than `delete` its own
  // injection (the prior bug) or overwrite the user's value (Superset's
  // failure mode). The user's auth/models/keymap and Orca's status plugin
  // both load via a single OPENCODE_CONFIG_DIR.
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
      join(userDataDir, 'opencode-config-overlays', toSafeDirName(ptyId))
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
      // Why: only the plugins/ subtree needs entry-by-entry mirroring so Orca
      // can drop a sibling file alongside the user's plugins. Other top-level
      // entries (auth.json, opencode.json) are mirrored as a single symlink so
      // user edits propagate live on POSIX.
      const service = new OpenCodeHookService()
      const env = service.buildPtyEnv(ptyId, userConfigDir)

      const overlay = env.OPENCODE_CONFIG_DIR!
      expect(lstatSync(join(overlay, 'opencode.json')).isSymbolicLink()).toBe(true)
      expect(lstatSync(join(overlay, 'auth.json')).isSymbolicLink()).toBe(true)
      // plugins/ must be a real directory in the overlay so Orca can write
      // its sibling status plugin into it.
      expect(lstatSync(join(overlay, 'plugins')).isDirectory()).toBe(true)
      expect(lstatSync(join(overlay, 'plugins')).isSymbolicLink()).toBe(false)
      // user-plugin.js inside plugins/ is mirrored entry-by-entry.
      expect(lstatSync(join(overlay, 'plugins', 'user-plugin.js')).isSymbolicLink()).toBe(true)
    }
  )

  it("does not overwrite a user plugin file with the same filename as Orca's plugin", () => {
    // Why: the failure mode this guards against — a user-owned plugin file
    // happens to be named orca-opencode-status.js. Without the per-entry
    // skip in mirrorUserConfig, the file would be linked into the overlay
    // and Orca's writeFileSync would write through the symlink, destroying
    // the user's content on their real filesystem.
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
      // Why: if plugins/ is a symlink (common dotfiles pattern), writing Orca's
      // status plugin through it would land in the user's real filesystem —
      // exactly the failure mode docs/opencode-config-dir-collision.md rejects.
      const realPluginsDir = mkdtempSync(join(tmpdir(), 'orca-real-plugins-'))
      try {
        writeFileSync(join(realPluginsDir, 'real-plugin.js'), 'REAL USER PLUGIN')

        // Replace the userConfigDir/plugins dir created by beforeEach with a
        // symlink pointing at the external "real" plugins dir.
        rmSync(join(userConfigDir, 'plugins'), { recursive: true, force: true })
        symlinkSync(realPluginsDir, join(userConfigDir, 'plugins'), 'dir')

        const service = new OpenCodeHookService()
        const env = service.buildPtyEnv(ptyId, userConfigDir)

        // The user's real filesystem must NOT receive Orca's status plugin.
        expect(existsSync(join(realPluginsDir, 'orca-opencode-status.js'))).toBe(false)
        // Overlay's plugins/ must be a real directory, not a symlink that
        // would write through to the user's filesystem.
        expect(lstatSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins')).isSymbolicLink()).toBe(false)
        // Orca's status plugin lands in the overlay only.
        expect(
          existsSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'))
        ).toBe(true)
        // The user's sentinel plugin is reachable through the overlay (mirrored
        // entry-by-entry after resolving the symlink target).
        expect(
          readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'real-plugin.js'), 'utf8')
        ).toBe('REAL USER PLUGIN')
      } finally {
        rmSync(realPluginsDir, { recursive: true, force: true })
      }
    }
  )

  it("preserves the user's OPENCODE_CONFIG_DIR when the path does not exist", () => {
    // Why: typoed user path — overriding it with an Orca-owned dir would let
    // Orca's status plugin "succeed" while silently hiding the user's typo.
    // The design rejects that: leave the user's value alone and let OpenCode
    // surface the typo on its own.
    const service = new OpenCodeHookService()
    const missingPath = join(tmpdir(), `orca-opencode-nope-${Date.now()}`)
    expect(existsSync(missingPath)).toBe(false)

    const env = service.buildPtyEnv(ptyId, missingPath)
    expect(env).toEqual({ OPENCODE_CONFIG_DIR: missingPath })
    // No overlay was created at the typo path.
    expect(existsSync(missingPath)).toBe(false)
    // No overlay dir under userData either.
    expect(existsSync(join(userDataDir, 'opencode-config-overlays', toSafeDirName(ptyId)))).toBe(
      false
    )
  })

  it("preserves the user's OPENCODE_CONFIG_DIR when the mirror step fails", async () => {
    // Why: mock the shared mirrorEntry helper to throw on the first symlink
    // (e.g. Windows without developer mode → EPERM). The hook service must
    // catch and fall back to { OPENCODE_CONFIG_DIR: existingConfigDir } —
    // the user's plugins/auth/models keep loading; only Orca's status plugin
    // is forfeited.
    const overlayMirror = await import('../pty/overlay-mirror')
    const mirrorSpy = vi.spyOn(overlayMirror, 'mirrorEntry').mockImplementation(() => {
      throw new Error('simulated EPERM on symlink')
    })
    try {
      const service = new OpenCodeHookService()
      const env = service.buildPtyEnv(ptyId, userConfigDir)
      expect(env).toEqual({ OPENCODE_CONFIG_DIR: userConfigDir })
      // Overlay dir was rolled back so a half-built tree does not leak.
      const overlayDir = join(userDataDir, 'opencode-config-overlays', toSafeDirName(ptyId))
      expect(existsSync(overlayDir)).toBe(false)
      expectUserConfigIntact()
    } finally {
      mirrorSpy.mockRestore()
    }
  })

  it.skipIf(process.platform === 'win32')(
    'clearPty removes the overlay without following symlinks into the user dir',
    () => {
      // Critical regression guard from issue #1083: the overlay's mirrored
      // entries are symlinks pointing at the user's real config. Recursive
      // teardown must NEVER walk through them.
      const service = new OpenCodeHookService()
      service.buildPtyEnv(ptyId, userConfigDir)

      const overlayDir = join(userDataDir, 'opencode-config-overlays', toSafeDirName(ptyId))
      expect(existsSync(overlayDir)).toBe(true)

      service.clearPty(ptyId)

      expect(existsSync(overlayDir)).toBe(false)
      // User config must still exist with all original contents.
      expectUserConfigIntact()
      // The plugins/ dir under the user config is also intact.
      expect(readdirSync(join(userConfigDir, 'plugins'))).toEqual(['user-plugin.js'])
    }
  )

  it('rebuilding the overlay for the same ptyId does not corrupt the user dir', () => {
    // Mirrors the daemon cold-restore code path that calls buildPtyEnv with
    // the same sessionId across restarts. Each rebuild must clear the prior
    // overlay safely (no symlink-walk into user data) and produce a fresh
    // overlay with both user files and Orca's plugin.
    const service = new OpenCodeHookService()
    service.buildPtyEnv(ptyId, userConfigDir)
    service.buildPtyEnv(ptyId, userConfigDir)
    const env = service.buildPtyEnv(ptyId, userConfigDir)

    expect(
      readFileSync(join(env.OPENCODE_CONFIG_DIR!, 'plugins', 'orca-opencode-status.js'), 'utf8')
    ).toContain('OrcaOpenCodeStatusPlugin')
    expectUserConfigIntact()
  })
})
