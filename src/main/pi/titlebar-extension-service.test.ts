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
import { join } from 'path'

// The service calls app.getPath('userData') for its overlay root. Point that
// at a real tmp dir so we can exercise the filesystem behavior end-to-end.
const userDataDir = mkdtempSync(join(tmpdir(), 'orca-pi-test-userdata-'))

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

  it('buildPtyEnv mirrors the user Pi dir into an overlay under userData', () => {
    const svc = new PiTitlebarExtensionService()
    const env = svc.buildPtyEnv('pty-1', piHome)

    expect(env.PI_CODING_AGENT_DIR).toBe(join(userDataDir, 'pi-agent-overlays', 'pty-1'))
    // Orca's titlebar extension is added alongside user extensions, not replacing them.
    const overlayExtensions = readdirSync(join(env.PI_CODING_AGENT_DIR!, 'extensions')).sort()
    expect(overlayExtensions).toEqual(['orca-titlebar-spinner.ts', 'user-ext'])
    // User's top-level resources are reachable via the overlay.
    expect(existsSync(join(env.PI_CODING_AGENT_DIR!, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(env.PI_CODING_AGENT_DIR!, 'auth.json'))).toBe(true)
    expectPiHomeIntact()
  })

  it('clearPty removes the overlay without touching the user Pi dir (issue #1083)', () => {
    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-2', piHome)
    svc.clearPty('pty-2')

    expect(existsSync(join(userDataDir, 'pi-agent-overlays', 'pty-2'))).toBe(false)
    // Critical regression guard: destroying the overlay MUST NOT destroy the
    // user's Pi home, even though every top-level entry in the overlay is a
    // symlink/junction pointing back into it.
    expectPiHomeIntact()
  })

  it('rebuilding an overlay for the same ptyId does not corrupt the user Pi dir', () => {
    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-3', piHome)
    svc.buildPtyEnv('pty-3', piHome)
    svc.buildPtyEnv('pty-3', piHome)
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
      const env = svc.buildPtyEnv('pty-4', piHome)

      expect(env.PI_CODING_AGENT_DIR).toBe(overlayDir)
      expect(existsSync(join(overlayDir, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
      expectPiHomeIntact()
    }
  )

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
    // The overlay root is userData/pi-agent-overlays; any path outside it
    // must be a no-op, not a `rm -rf` on arbitrary filesystem locations.
    const svc = new PiTitlebarExtensionService() as unknown as {
      safeRemoveOverlay: (p: string) => void
    }
    svc.safeRemoveOverlay(piHome)
    svc.safeRemoveOverlay('/')
    svc.safeRemoveOverlay(join(userDataDir, 'pi-agent-overlays')) // root itself
    expectPiHomeIntact()
  })
})
