import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import type * as osModule from 'os'
import { join } from 'path'

// The service calls app.getPath('userData') for its overlay root. Point that
// at a real tmp dir so we can exercise the filesystem behavior end-to-end.
const userDataDir = mkdtempSync(join(tmpdir(), 'orca-pi-test-userdata-'))

// Why: getDefaultPiAgentDir() inside titlebar-extension-service reads
// homedir() from 'os'. To exercise the ~/.omp/agent fallback branch we
// route the homedir lookup through a mutable holder so a single test can
// point it at a controlled tmp dir without disturbing the eagerly-evaluated
// tmpdir()/mkdtempSync calls above.
const homedirOverride = vi.hoisted(() => ({ current: '' as string }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: () => homedirOverride.current || actual.homedir()
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return userDataDir
      }
      throw new Error(`unexpected app.getPath(${name})`)
    }
  }
}))

import { PiTitlebarExtensionService, isSafeDescendCandidate } from './titlebar-extension-service'

describe('PiTitlebarExtensionService', () => {
  let piHome: string

  beforeEach(() => {
    piHome = mkdtempSync(join(tmpdir(), 'orca-pi-test-pihome-'))
    // Seed a realistic Pi agent dir with skills, extensions, auth, sessions.
    mkdirSync(join(piHome, 'skills', 'my-skill', 'nested'), { recursive: true })
    writeFileSync(join(piHome, 'skills', 'my-skill', 'SKILL.md'), 'critical user skill')
    writeFileSync(join(piHome, 'skills', 'my-skill', 'nested', 'data.txt'), 'nested data')
    mkdirSync(join(piHome, 'extensions', 'user-ext'), { recursive: true })
    writeFileSync(join(piHome, 'extensions', 'user-ext', 'ext.ts'), 'user extension')
    mkdirSync(join(piHome, 'sessions'), { recursive: true })
    writeFileSync(join(piHome, 'sessions', 'session-1.json'), '{}')
    writeFileSync(join(piHome, 'auth.json'), 'secret token')
  })

  afterEach(() => {
    rmSync(piHome, { recursive: true, force: true })
    rmSync(join(userDataDir, 'pi-agent-overlays'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'omp-agent-overlays'), { recursive: true, force: true })
  })

  function expectPiHomeIntact(): void {
    expect(readFileSync(join(piHome, 'auth.json'), 'utf-8')).toBe('secret token')
    expect(readFileSync(join(piHome, 'skills', 'my-skill', 'SKILL.md'), 'utf-8')).toBe(
      'critical user skill'
    )
    expect(readFileSync(join(piHome, 'skills', 'my-skill', 'nested', 'data.txt'), 'utf-8')).toBe(
      'nested data'
    )
    expect(readFileSync(join(piHome, 'extensions', 'user-ext', 'ext.ts'), 'utf-8')).toBe(
      'user extension'
    )
    expect(readFileSync(join(piHome, 'sessions', 'session-1.json'), 'utf-8')).toBe('{}')
  }

  it('buildPtyEnv mirrors the user agent dir into an overlay under userData', () => {
    const svc = new PiTitlebarExtensionService()
    const env = svc.buildPtyEnv('pty-1', piHome, 'pi')

    expect(env.PI_CODING_AGENT_DIR).toBe(join(userDataDir, 'pi-agent-overlays', 'pty-1'))
    // Orca's titlebar extension is added alongside user extensions, not replacing them.
    const overlayExtensions = readdirSync(join(env.PI_CODING_AGENT_DIR!, 'extensions')).sort()
    expect(overlayExtensions).toEqual([
      'orca-agent-status.ts',
      'orca-prefill.ts',
      'orca-titlebar-spinner.ts',
      'user-ext'
    ])
    const statusExtensionSource = readFileSync(
      join(env.PI_CODING_AGENT_DIR!, 'extensions', 'orca-agent-status.ts'),
      'utf-8'
    )
    expect(statusExtensionSource).toContain('/hook/pi')
    expect(statusExtensionSource).toContain('process.title')
    expect(statusExtensionSource).toContain("return '/hook/omp'")
    // User's top-level resources are reachable via the overlay.
    expect(existsSync(join(env.PI_CODING_AGENT_DIR!, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(env.PI_CODING_AGENT_DIR!, 'auth.json'))).toBe(true)
    expectPiHomeIntact()
  })

  it('clearPty removes the overlay without touching the user Pi dir (issue #1083)', () => {
    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-2', piHome, 'pi')
    svc.clearPty('pty-2')

    expect(existsSync(join(userDataDir, 'pi-agent-overlays', 'pty-2'))).toBe(false)
    // Critical regression guard: destroying the overlay MUST NOT destroy the
    // user's Pi home, even though every top-level entry in the overlay is a
    // symlink/junction pointing back into it.
    expectPiHomeIntact()
  })

  it('rebuilding an overlay for the same ptyId does not corrupt the user Pi dir', () => {
    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-3', piHome, 'pi')
    svc.buildPtyEnv('pty-3', piHome, 'pi')
    svc.buildPtyEnv('pty-3', piHome, 'pi')
    expectPiHomeIntact()
  })

  // Why: symlinkSync on Windows requires developer mode or admin — skip on
  // Windows rather than fail for environmental reasons. The isSafeDescendCandidate
  // unit tests above cover the Windows ordering invariant separately.
  it.skipIf(process.platform === 'win32')(
    'safely handles a pre-existing stale overlay with dangling symlinks',
    () => {
      // Why: simulate an overlay that was left behind by a prior Orca session,
      // where the original Pi home it mirrored has since moved. The teardown
      // should unlink the dangling symlinks in place without trying to follow them.
      const overlayDir = join(userDataDir, 'pi-agent-overlays', 'pty-4')
      mkdirSync(overlayDir, { recursive: true })
      symlinkSync('/nonexistent-pi-target/skills', join(overlayDir, 'skills'), 'dir')
      symlinkSync('/nonexistent-pi-target/auth.json', join(overlayDir, 'auth.json'), 'file')

      const svc = new PiTitlebarExtensionService()
      const env = svc.buildPtyEnv('pty-4', piHome, 'pi')

      expect(env.PI_CODING_AGENT_DIR).toBe(overlayDir)
      expect(existsSync(join(overlayDir, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
      expectPiHomeIntact()
    }
  )

  // Why: per-agent overlay source dir. Orca's user picks Pi or OMP per
  // launch (the agent kind isn't a global install-time choice), so each
  // build's source dir MUST be resolved from the agent kind, not from a
  // disk-presence check that silently shadows the other agent's user
  // extensions when both `~/.pi/agent` and `~/.omp/agent` exist.
  describe('per-agent default source dir (no cross-agent fallback)', () => {
    function seedAgentDir(home: string, dotDir: '.pi' | '.omp', tag: string): string {
      const agentDir = join(home, dotDir, 'agent')
      mkdirSync(join(agentDir, 'extensions', `${tag}-ext`), { recursive: true })
      writeFileSync(join(agentDir, 'extensions', `${tag}-ext`, 'ext.ts'), `${tag} user extension`)
      writeFileSync(join(agentDir, 'auth.json'), `${tag} secret token`)
      return agentDir
    }

    it('launching pi with both ~/.pi/agent and ~/.omp/agent present mirrors ~/.pi/agent', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'orca-pi-both-'))
      seedAgentDir(fakeHome, '.pi', 'pi')
      seedAgentDir(fakeHome, '.omp', 'omp')

      homedirOverride.current = fakeHome
      try {
        const svc = new PiTitlebarExtensionService()
        const env = svc.buildPtyEnv('pty-pi-both', undefined, 'pi')

        expect(env.PI_CODING_AGENT_DIR).toBe(join(userDataDir, 'pi-agent-overlays', 'pty-pi-both'))
        // The Pi auth file must be the one mirrored (not OMP's).
        expect(readFileSync(join(env.PI_CODING_AGENT_DIR!, 'auth.json'), 'utf-8')).toBe(
          'pi secret token'
        )
        // The user extension dir must be Pi's, not OMP's.
        const overlayExtensions = readdirSync(join(env.PI_CODING_AGENT_DIR!, 'extensions')).sort()
        expect(overlayExtensions).toContain('pi-ext')
        expect(overlayExtensions).not.toContain('omp-ext')
      } finally {
        homedirOverride.current = ''
        rmSync(join(userDataDir, 'pi-agent-overlays', 'pty-pi-both'), {
          recursive: true,
          force: true
        })
        rmSync(fakeHome, { recursive: true, force: true })
      }
    })

    it('launching omp with both ~/.pi/agent and ~/.omp/agent present mirrors ~/.omp/agent into omp-agent-overlays', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'orca-omp-both-'))
      seedAgentDir(fakeHome, '.pi', 'pi')
      seedAgentDir(fakeHome, '.omp', 'omp')

      homedirOverride.current = fakeHome
      try {
        const svc = new PiTitlebarExtensionService()
        const env = svc.buildPtyEnv('pty-omp-both', undefined, 'omp')

        // Critical regression guard for "OMP is its own program with its own
        // paths": OMP overlays live under userData/omp-agent-overlays, NEVER
        // under userData/pi-agent-overlays. A future refactor that re-shares
        // the Pi overlay root for OMP would re-introduce cross-agent state
        // visibility this PR exists to prevent.
        expect(env.PI_CODING_AGENT_DIR).toBe(
          join(userDataDir, 'omp-agent-overlays', 'pty-omp-both')
        )
        // CRITICAL regression guard: even though ~/.pi/agent exists, the OMP
        // launch MUST resolve OMP's own source dir, not Pi's.
        expect(readFileSync(join(env.PI_CODING_AGENT_DIR!, 'auth.json'), 'utf-8')).toBe(
          'omp secret token'
        )
        const overlayExtensions = readdirSync(join(env.PI_CODING_AGENT_DIR!, 'extensions')).sort()
        expect(overlayExtensions).toContain('omp-ext')
        expect(overlayExtensions).not.toContain('pi-ext')
        expect(
          readFileSync(
            join(env.PI_CODING_AGENT_DIR!, 'extensions', 'orca-agent-status.ts'),
            'utf-8'
          )
        ).toContain('/hook/omp')
        // Pi's overlay root MUST NOT have been touched by the OMP launch.
        expect(existsSync(join(userDataDir, 'pi-agent-overlays', 'pty-omp-both'))).toBe(false)
      } finally {
        homedirOverride.current = ''
        rmSync(join(userDataDir, 'omp-agent-overlays', 'pty-omp-both'), {
          recursive: true,
          force: true
        })
        rmSync(fakeHome, { recursive: true, force: true })
      }
    })

    it('launching omp when only ~/.pi/agent exists does NOT mirror Pi state', () => {
      // Why: missing source dir for the resolved kind must materialize the
      // overlay from empty (Orca extensions only) — never cross-pollinate
      // from the other agent's dir.
      const fakeHome = mkdtempSync(join(tmpdir(), 'orca-omp-only-pi-'))
      seedAgentDir(fakeHome, '.pi', 'pi')
      expect(existsSync(join(fakeHome, '.omp'))).toBe(false)

      homedirOverride.current = fakeHome
      try {
        const svc = new PiTitlebarExtensionService()
        const env = svc.buildPtyEnv('pty-omp-empty', undefined, 'omp')

        expect(env.PI_CODING_AGENT_DIR).toBe(
          join(userDataDir, 'omp-agent-overlays', 'pty-omp-empty')
        )
        // The Pi-only home must NOT leak into the OMP overlay; the auth
        // token from ~/.pi/agent/auth.json must be absent.
        expect(existsSync(join(env.PI_CODING_AGENT_DIR!, 'auth.json'))).toBe(false)
        // Only Orca's bundled extensions are present — no user extensions
        // from the other agent's dir.
        const overlayExtensions = readdirSync(join(env.PI_CODING_AGENT_DIR!, 'extensions')).sort()
        expect(overlayExtensions).toEqual([
          'orca-agent-status.ts',
          'orca-prefill.ts',
          'orca-titlebar-spinner.ts'
        ])
      } finally {
        homedirOverride.current = ''
        rmSync(join(userDataDir, 'omp-agent-overlays', 'pty-omp-empty'), {
          recursive: true,
          force: true
        })
        rmSync(fakeHome, { recursive: true, force: true })
      }
    })
  })

  describe('isSafeDescendCandidate (Windows junction regression guard)', () => {
    // Why: the #1083 regression cannot reproduce on POSIX CI because
    // fs.rmSync({recursive:true}) handles symlinks correctly on macOS/Linux.
    // The behavior that DID cause the data loss on Windows was directory
    // junctions reporting BOTH isSymbolicLink() === true AND isDirectory()
    // === true from lstat/Dirent. These unit tests pin the predicate's
    // ordering so a future refactor cannot reverse it without the test suite
    // failing, regardless of which OS the tests run on.
    it('rejects a Windows directory junction (symlink + directory both true)', () => {
      const junctionLike = {
        isSymbolicLink: () => true,
        isDirectory: () => true
      }
      expect(isSafeDescendCandidate(junctionLike)).toBe(false)
    })

    it('rejects a plain symlink', () => {
      expect(isSafeDescendCandidate({ isSymbolicLink: () => true, isDirectory: () => false })).toBe(
        false
      )
    })

    it('rejects a regular file', () => {
      expect(
        isSafeDescendCandidate({ isSymbolicLink: () => false, isDirectory: () => false })
      ).toBe(false)
    })

    it('accepts a true directory (non-symlink)', () => {
      expect(isSafeDescendCandidate({ isSymbolicLink: () => false, isDirectory: () => true })).toBe(
        true
      )
    })
  })

  it('refuses to remove anything outside the overlay root', () => {
    // Why: hard guard against a misresolved overlay path (regression defense).
    // The overlay roots are userData/{pi,omp}-agent-overlays; any path outside
    // either must be a no-op, not a `rm -rf` on arbitrary filesystem locations.
    const svc = new PiTitlebarExtensionService() as unknown as {
      safeRemoveOverlay: (p: string, kind: 'pi' | 'omp') => void
    }
    svc.safeRemoveOverlay(piHome, 'pi')
    svc.safeRemoveOverlay(piHome, 'omp')
    svc.safeRemoveOverlay('/', 'pi')
    svc.safeRemoveOverlay(join(userDataDir, 'pi-agent-overlays'), 'pi') // root itself
    svc.safeRemoveOverlay(join(userDataDir, 'omp-agent-overlays'), 'omp') // OMP root itself
    expectPiHomeIntact()
  })
})
