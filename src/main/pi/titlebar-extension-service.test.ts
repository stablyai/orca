import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
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
import type * as osModule from 'node:os'
import type * as fsModule from 'node:fs'
import { join } from 'node:path'

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

function legacyOverlayPath(kind: 'pi' | 'omp', ptyId: string): string {
  const rootDir = kind === 'pi' ? 'pi-agent-overlays' : 'omp-agent-overlays'
  return join(userDataDir, rootDir, ptyId)
}

function legacySourceOverlayPath(kind: 'pi' | 'omp', sourceAgentDir: string): string {
  const rootDir = kind === 'pi' ? 'pi-agent-overlays' : 'omp-agent-overlays'
  const hashed = createHash('sha256').update(`source:${sourceAgentDir}`).digest('hex').slice(0, 32)
  return join(userDataDir, rootDir, hashed)
}

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
    writeFileSync(
      join(piHome, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'amazon-bedrock',
        hideThinkingBlock: false,
        packages: ['npm:pi-web-access'],
        terminal: {
          showImages: false,
          clearOnShrink: false
        }
      })
    )
  })

  afterEach(() => {
    rmSync(piHome, { recursive: true, force: true })
    rmSync(join(userDataDir, 'pi-agent-overlays'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'omp-agent-overlays'), { recursive: true, force: true })
    rmSync(join(userDataDir, 'omp-managed-status-extension'), { recursive: true, force: true })
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
    expect(JSON.parse(readFileSync(join(piHome, 'settings.json'), 'utf-8'))).toEqual({
      defaultProvider: 'amazon-bedrock',
      hideThinkingBlock: false,
      packages: ['npm:pi-web-access'],
      terminal: {
        showImages: false,
        clearOnShrink: false
      }
    })
  }

  it('buildPtyEnv installs Orca extensions into the user agent dir without redirecting the home', () => {
    const svc = new PiTitlebarExtensionService()
    const env = svc.buildPtyEnv('pty-1', piHome, 'pi')

    expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe(piHome)
    const extensions = readdirSync(join(piHome, 'extensions')).sort()
    expect(extensions).toEqual([
      'orca-agent-status.ts',
      'orca-prefill.ts',
      'orca-titlebar-spinner.ts',
      'user-ext'
    ])
    const statusExtensionSource = readFileSync(
      join(piHome, 'extensions', 'orca-agent-status.ts'),
      'utf-8'
    )
    const titlebarExtensionSource = readFileSync(
      join(piHome, 'extensions', 'orca-titlebar-spinner.ts'),
      'utf-8'
    )
    const prefillExtensionSource = readFileSync(
      join(piHome, 'extensions', 'orca-prefill.ts'),
      'utf-8'
    )
    expect(statusExtensionSource).toContain('@orca-managed-pi-extension')
    expect(statusExtensionSource).toContain('/hook/pi')
    expect(statusExtensionSource).toContain('process.title')
    expect(statusExtensionSource).toContain("return '/hook/omp'")
    expect(titlebarExtensionSource).toContain('@orca-managed-pi-extension')
    expect(titlebarExtensionSource).toContain('process.env.ORCA_PANE_KEY')
    expect(prefillExtensionSource).toContain('@orca-managed-pi-extension')
    expect(prefillExtensionSource).toContain('process.env.ORCA_PANE_KEY')
    expectPiHomeIntact()
  })

  it('clearPty leaves the real Pi dir and managed extensions intact', () => {
    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-2', piHome, 'pi')
    svc.clearPty('pty-2')

    expect(existsSync(join(piHome, 'extensions', 'orca-agent-status.ts'))).toBe(true)
    expectPiHomeIntact()
  })

  it('uses the same source dir for multiple PTYs with the same Pi dir', () => {
    const svc = new PiTitlebarExtensionService()
    const firstEnv = svc.buildPtyEnv('pty-shared-1', piHome, 'pi')
    const secondEnv = svc.buildPtyEnv('pty-shared-2', piHome, 'pi')

    expect(firstEnv.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(secondEnv.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(secondEnv.ORCA_PI_SOURCE_AGENT_DIR).toBe(firstEnv.ORCA_PI_SOURCE_AGENT_DIR)
    expect(readFileSync(join(piHome, 'extensions', 'user-ext', 'ext.ts'), 'utf-8')).toBe(
      'user extension'
    )
    expectPiHomeIntact()
  })

  it('leaves OMP SQLite files in the real home instead of redirecting to an overlay', () => {
    const svc = new PiTitlebarExtensionService()
    const env = svc.buildPtyEnv('pty-omp-sqlite', piHome, 'omp')

    const sourcePath = join(piHome, 'agent.db')
    const content = 'agent.db credentials'

    expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBe(piHome)
    expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(join(piHome, 'extensions', 'orca-agent-status.ts'))
    expect(existsSync(sourcePath)).toBe(false)
    expect(existsSync(join(userDataDir, 'omp-agent-overlays'))).toBe(false)
    expect(existsSync(join(piHome, 'history.db'))).toBe(false)
    writeFileSync(sourcePath, content)

    expect(readFileSync(sourcePath, 'utf-8')).toBe(content)
  })

  it('migrates missing OMP state from the old source overlay without overwriting source files', () => {
    rmSync(join(piHome, 'sessions'), { recursive: true, force: true })
    const overlayDir = legacySourceOverlayPath('omp', piHome)
    mkdirSync(join(overlayDir, 'sessions'), { recursive: true })
    mkdirSync(join(overlayDir, 'extensions'), { recursive: true })
    writeFileSync(join(overlayDir, 'agent.db'), 'legacy sqlite credentials')
    writeFileSync(join(overlayDir, 'agent.db-wal'), 'legacy sqlite wal')
    writeFileSync(join(overlayDir, 'sessions', 'legacy-session.jsonl'), 'legacy transcript')
    writeFileSync(join(overlayDir, 'auth.json'), 'legacy token should not overwrite')
    writeFileSync(join(overlayDir, 'settings.json'), '{"overlayOnly":true}')
    writeFileSync(join(overlayDir, '.orca-pi-overlay-manifest.json'), '{}')
    writeFileSync(join(overlayDir, 'extensions', 'orca-agent-status.ts'), 'stale managed extension')
    writeFileSync(join(overlayDir, 'extensions', 'legacy-user-ext.ts'), 'legacy user extension')
    mkdirSync(join(overlayDir, 'extensions', 'legacy-package'), { recursive: true })
    writeFileSync(
      join(overlayDir, 'extensions', 'legacy-package', 'orca-prefill.ts'),
      'user package file'
    )

    const svc = new PiTitlebarExtensionService()
    const env = svc.buildPtyEnv('pty-omp-migrate', piHome, 'omp')

    expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(readFileSync(join(piHome, 'agent.db'), 'utf-8')).toBe('legacy sqlite credentials')
    expect(readFileSync(join(piHome, 'agent.db-wal'), 'utf-8')).toBe('legacy sqlite wal')
    expect(readFileSync(join(piHome, 'sessions', 'legacy-session.jsonl'), 'utf-8')).toBe(
      'legacy transcript'
    )
    expect(readFileSync(join(piHome, 'auth.json'), 'utf-8')).toBe('secret token')
    expect(JSON.parse(readFileSync(join(piHome, 'settings.json'), 'utf-8'))).toEqual({
      defaultProvider: 'amazon-bedrock',
      hideThinkingBlock: false,
      packages: ['npm:pi-web-access'],
      terminal: {
        showImages: false,
        clearOnShrink: false
      }
    })
    expect(readFileSync(join(piHome, 'extensions', 'legacy-user-ext.ts'), 'utf-8')).toBe(
      'legacy user extension'
    )
    expect(
      readFileSync(join(piHome, 'extensions', 'legacy-package', 'orca-prefill.ts'), 'utf-8')
    ).toBe('user package file')
    expect(readFileSync(join(piHome, 'extensions', 'orca-agent-status.ts'), 'utf-8')).toContain(
      '/hook/omp'
    )
    expect(readFileSync(join(overlayDir, '.orca-omp-overlay-migration-complete'), 'utf-8')).toBe(
      'complete\n'
    )
  })

  it('does not copy stale SQLite sidecars when the target database already exists', () => {
    const overlayDir = legacySourceOverlayPath('omp', piHome)
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'agent.db'), 'legacy sqlite credentials')
    writeFileSync(join(overlayDir, 'agent.db-wal'), 'legacy sqlite wal')
    writeFileSync(join(overlayDir, 'agent.db-shm'), 'legacy sqlite shm')
    writeFileSync(join(piHome, 'agent.db'), 'fresh sqlite credentials')

    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-omp-stale-sidecars', piHome, 'omp')

    expect(readFileSync(join(piHome, 'agent.db'), 'utf-8')).toBe('fresh sqlite credentials')
    expect(existsSync(join(piHome, 'agent.db-wal'))).toBe(false)
    expect(existsSync(join(piHome, 'agent.db-shm'))).toBe(false)
    expect(readFileSync(join(overlayDir, '.orca-omp-overlay-migration-complete'), 'utf-8')).toBe(
      'complete\n'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'retries a legacy SQLite migration as a whole set after sidecar copy failure',
    () => {
      const overlayDir = legacySourceOverlayPath('omp', piHome)
      mkdirSync(overlayDir, { recursive: true })
      const walPath = join(overlayDir, 'agent.db-wal')
      writeFileSync(join(overlayDir, 'agent.db'), 'legacy sqlite credentials')
      writeFileSync(walPath, 'legacy sqlite wal')
      chmodSync(walPath, 0o000)

      try {
        const svc = new PiTitlebarExtensionService()
        svc.buildPtyEnv('pty-omp-sidecar-fail-1', piHome, 'omp')

        expect(existsSync(join(piHome, 'agent.db'))).toBe(false)
        expect(existsSync(join(piHome, 'agent.db-wal'))).toBe(false)
        expect(existsSync(join(overlayDir, '.orca-omp-overlay-migration-complete'))).toBe(false)

        chmodSync(walPath, 0o600)
        svc.buildPtyEnv('pty-omp-sidecar-fail-2', piHome, 'omp')

        expect(readFileSync(join(piHome, 'agent.db'), 'utf-8')).toBe('legacy sqlite credentials')
        expect(readFileSync(join(piHome, 'agent.db-wal'), 'utf-8')).toBe('legacy sqlite wal')
        expect(
          readFileSync(join(overlayDir, '.orca-omp-overlay-migration-complete'), 'utf-8')
        ).toBe('complete\n')
      } finally {
        chmodSync(walPath, 0o600)
      }
    }
  )

  it('retries a legacy SQLite migration as a whole set after sidecar stat failure', async () => {
    const overlayDir = legacySourceOverlayPath('omp', piHome)
    mkdirSync(overlayDir, { recursive: true })
    const walPath = join(overlayDir, 'agent.db-wal')
    writeFileSync(join(overlayDir, 'agent.db'), 'legacy sqlite credentials')
    writeFileSync(walPath, 'legacy sqlite wal')

    let failNextWalStat = true
    vi.resetModules()
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof fsModule>()
      return {
        ...actual,
        lstatSync: (path: Parameters<typeof actual.lstatSync>[0]) => {
          if (String(path) === walPath && failNextWalStat) {
            failNextWalStat = false
            throw new Error('transient lstat failure')
          }
          return actual.lstatSync(path)
        }
      }
    })

    try {
      const { migrateLegacyOmpOverlayState } = await import('./legacy-omp-overlay-migration')
      migrateLegacyOmpOverlayState(piHome, overlayDir)

      expect(existsSync(join(piHome, 'agent.db'))).toBe(false)
      expect(existsSync(join(piHome, 'agent.db-wal'))).toBe(false)
      expect(existsSync(join(overlayDir, '.orca-omp-overlay-migration-complete'))).toBe(false)

      migrateLegacyOmpOverlayState(piHome, overlayDir)

      expect(readFileSync(join(piHome, 'agent.db'), 'utf-8')).toBe('legacy sqlite credentials')
      expect(readFileSync(join(piHome, 'agent.db-wal'), 'utf-8')).toBe('legacy sqlite wal')
      expect(readFileSync(join(overlayDir, '.orca-omp-overlay-migration-complete'), 'utf-8')).toBe(
        'complete\n'
      )
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('marks successful legacy OMP migrations so old overlays are not re-scanned', () => {
    const overlayDir = legacySourceOverlayPath('omp', piHome)
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'agent.db'), 'legacy sqlite credentials')

    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-omp-migrate-once-1', piHome, 'omp')

    expect(readFileSync(join(piHome, 'agent.db'), 'utf-8')).toBe('legacy sqlite credentials')
    expect(readFileSync(join(overlayDir, '.orca-omp-overlay-migration-complete'), 'utf-8')).toBe(
      'complete\n'
    )

    writeFileSync(join(overlayDir, 'later-overlay-only-file'), 'should not migrate')
    svc.buildPtyEnv('pty-omp-migrate-once-2', piHome, 'omp')

    expect(existsSync(join(piHome, 'later-overlay-only-file'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'skips special legacy overlay entries while continuing the OMP migration',
    () => {
      rmSync(join(piHome, 'sessions'), { recursive: true, force: true })
      const overlayDir = legacySourceOverlayPath('omp', piHome)
      mkdirSync(join(overlayDir, 'sessions'), { recursive: true })
      execFileSync('mkfifo', [join(overlayDir, 'stray-fifo')])
      writeFileSync(join(overlayDir, 'sessions', 'legacy-session.jsonl'), 'legacy transcript')

      const svc = new PiTitlebarExtensionService()
      svc.buildPtyEnv('pty-omp-special-entry', piHome, 'omp')

      expect(existsSync(join(piHome, 'stray-fifo'))).toBe(false)
      expect(readFileSync(join(piHome, 'sessions', 'legacy-session.jsonl'), 'utf-8')).toBe(
        'legacy transcript'
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not descend through existing target directory symlinks while migrating OMP state',
    () => {
      rmSync(join(piHome, 'sessions'), { recursive: true, force: true })
      const overlayDir = legacySourceOverlayPath('omp', piHome)
      mkdirSync(join(overlayDir, 'sessions'), { recursive: true })
      writeFileSync(join(overlayDir, 'sessions', 'legacy-session.jsonl'), 'legacy transcript')
      const outsideDir = mkdtempSync(join(tmpdir(), 'orca-omp-target-junction-'))
      const sessionsPath = join(piHome, 'sessions')

      try {
        symlinkSync(outsideDir, sessionsPath, 'dir')
        const svc = new PiTitlebarExtensionService()
        svc.buildPtyEnv('pty-omp-target-dir-symlink', piHome, 'omp')

        expect(lstatSync(sessionsPath).isSymbolicLink()).toBe(true)
        expect(existsSync(join(outsideDir, 'legacy-session.jsonl'))).toBe(false)
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not follow existing target symlinks while migrating OMP state',
    () => {
      rmSync(join(piHome, 'sessions'), { recursive: true, force: true })
      const overlayDir = legacySourceOverlayPath('omp', piHome)
      mkdirSync(join(overlayDir, 'sessions'), { recursive: true })
      writeFileSync(join(overlayDir, 'agent.db'), 'legacy sqlite credentials')
      writeFileSync(join(overlayDir, 'sessions', 'legacy-session.jsonl'), 'legacy transcript')
      const outsideDir = mkdtempSync(join(tmpdir(), 'orca-omp-dangling-target-'))

      try {
        const outsideTarget = join(outsideDir, 'agent.db')
        symlinkSync(outsideTarget, join(piHome, 'agent.db'), 'file')

        const svc = new PiTitlebarExtensionService()
        svc.buildPtyEnv('pty-omp-target-symlink', piHome, 'omp')

        expect(existsSync(outsideTarget)).toBe(false)
        expect(lstatSync(join(piHome, 'agent.db')).isSymbolicLink()).toBe(true)
        expect(readFileSync(join(piHome, 'sessions', 'legacy-session.jsonl'), 'utf-8')).toBe(
          'legacy transcript'
        )
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    }
  )

  it('rebuilding managed extensions for the same ptyId does not corrupt the user Pi dir', () => {
    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-3', piHome, 'pi')
    svc.buildPtyEnv('pty-3', piHome, 'pi')
    svc.buildPtyEnv('pty-3', piHome, 'pi')
    expectPiHomeIntact()
  })

  it('rebuilding updates Orca-owned extensions while preserving user files', () => {
    const svc = new PiTitlebarExtensionService()
    svc.buildPtyEnv('pty-refresh-1', piHome, 'pi')
    writeFileSync(
      join(piHome, 'extensions', 'orca-agent-status.ts'),
      '// @orca-managed-pi-extension\nstale'
    )

    rmSync(join(piHome, 'extensions', 'user-ext'), { recursive: true, force: true })
    mkdirSync(join(piHome, 'extensions', 'new-ext'), { recursive: true })
    writeFileSync(join(piHome, 'extensions', 'new-ext', 'ext.ts'), 'new user extension')
    writeFileSync(join(piHome, 'auth.json'), 'rotated token')

    const secondEnv = svc.buildPtyEnv('pty-refresh-2', piHome, 'pi')

    expect(secondEnv.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(readFileSync(join(piHome, 'extensions', 'orca-agent-status.ts'), 'utf-8')).toContain(
      '/hook/pi'
    )
    expect(readFileSync(join(piHome, 'auth.json'), 'utf-8')).toBe('rotated token')
    expect(readFileSync(join(piHome, 'extensions', 'new-ext', 'ext.ts'), 'utf-8')).toBe(
      'new user extension'
    )
  })

  it("does not overwrite a user's same-named Orca extension file", () => {
    const userStatusExtension = 'user-owned status extension'
    writeFileSync(join(piHome, 'extensions', 'orca-agent-status.ts'), userStatusExtension, 'utf-8')

    const svc = new PiTitlebarExtensionService()
    const env = svc.buildPtyEnv('pty-same-name-extension', piHome, 'pi')

    expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(readFileSync(join(piHome, 'extensions', 'orca-agent-status.ts'), 'utf-8')).toBe(
      userStatusExtension
    )
    expectPiHomeIntact()
  })

  it('uses an Orca-owned OMP status extension when a same-named user file exists', () => {
    const userStatusExtension = 'user-owned status extension'
    const userStatusPath = join(piHome, 'extensions', 'orca-agent-status.ts')
    writeFileSync(userStatusPath, userStatusExtension, 'utf-8')

    const svc = new PiTitlebarExtensionService()
    const env = svc.buildPtyEnv('pty-omp-user-status-extension', piHome, 'omp')

    const fallbackStatusPath = join(
      userDataDir,
      'omp-managed-status-extension',
      'orca-agent-status.ts'
    )
    expect(readFileSync(userStatusPath, 'utf-8')).toBe(userStatusExtension)
    expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(fallbackStatusPath)
    expect(readFileSync(fallbackStatusPath, 'utf-8')).toContain('@orca-managed-pi-extension')
    expect(readFileSync(fallbackStatusPath, 'utf-8')).toContain('/hook/omp')
  })

  it.skipIf(process.platform === 'win32')(
    'writes bundled extensions through a symlinked user extensions dir',
    () => {
      const realExtensionsDir = mkdtempSync(join(tmpdir(), 'orca-real-pi-extensions-'))
      try {
        writeFileSync(join(realExtensionsDir, 'real-user-ext.ts'), 'real user extension')
        rmSync(join(piHome, 'extensions'), { recursive: true, force: true })
        symlinkSync(realExtensionsDir, join(piHome, 'extensions'), 'dir')

        const svc = new PiTitlebarExtensionService()
        const env = svc.buildPtyEnv('pty-symlinked-extensions', piHome, 'pi')

        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(existsSync(join(realExtensionsDir, 'orca-agent-status.ts'))).toBe(true)
        expect(existsSync(join(realExtensionsDir, 'orca-prefill.ts'))).toBe(true)
        expect(existsSync(join(realExtensionsDir, 'orca-titlebar-spinner.ts'))).toBe(true)
        expect(readFileSync(join(realExtensionsDir, 'orca-agent-status.ts'), 'utf-8')).toContain(
          '/hook/pi'
        )
      } finally {
        rmSync(realExtensionsDir, { recursive: true, force: true })
      }
    }
  )

  // Why: symlinkSync on Windows requires developer mode or admin — skip on
  // Windows rather than fail for environmental reasons. The isSafeDescendCandidate
  // unit tests above cover the Windows ordering invariant separately.
  it.skipIf(process.platform === 'win32')(
    'safely handles a pre-existing stale overlay with dangling symlinks',
    () => {
      // Why: simulate an overlay that was left behind by a prior Orca session,
      // where the original Pi home it mirrored has since moved. The teardown
      // should unlink the dangling symlinks in place without trying to follow them.
      const legacyOverlayDir = legacyOverlayPath('pi', 'pty-4')
      mkdirSync(legacyOverlayDir, { recursive: true })
      symlinkSync('/nonexistent-pi-target/skills', join(legacyOverlayDir, 'skills'), 'dir')
      symlinkSync('/nonexistent-pi-target/auth.json', join(legacyOverlayDir, 'auth.json'), 'file')

      const svc = new PiTitlebarExtensionService()
      const env = svc.buildPtyEnv('pty-4', piHome, 'pi')

      expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
      expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe(piHome)
      expect(existsSync(legacyOverlayDir)).toBe(false)
      expectPiHomeIntact()
    }
  )

  // Why: per-agent source dir. Orca's user picks Pi or OMP per
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

    it('launching pi with both ~/.pi/agent and ~/.omp/agent present installs into ~/.pi/agent', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'orca-pi-both-'))
      seedAgentDir(fakeHome, '.pi', 'pi')
      seedAgentDir(fakeHome, '.omp', 'omp')

      homedirOverride.current = fakeHome
      try {
        const svc = new PiTitlebarExtensionService()
        const env = svc.buildPtyEnv('pty-pi-both', undefined, 'pi')

        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_PI_SOURCE_AGENT_DIR).toBe(join(fakeHome, '.pi', 'agent'))
        expect(
          existsSync(join(fakeHome, '.pi', 'agent', 'extensions', 'orca-agent-status.ts'))
        ).toBe(true)
        expect(
          existsSync(join(fakeHome, '.omp', 'agent', 'extensions', 'orca-agent-status.ts'))
        ).toBe(false)
      } finally {
        homedirOverride.current = ''
        rmSync(fakeHome, { recursive: true, force: true })
      }
    })

    it('launching omp with both ~/.pi/agent and ~/.omp/agent present installs into ~/.omp/agent', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'orca-omp-both-'))
      seedAgentDir(fakeHome, '.pi', 'pi')
      seedAgentDir(fakeHome, '.omp', 'omp')

      homedirOverride.current = fakeHome
      try {
        const svc = new PiTitlebarExtensionService()
        const env = svc.buildPtyEnv('pty-omp-both', undefined, 'omp')

        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBe(join(fakeHome, '.omp', 'agent'))
        expect(env.ORCA_OMP_STATUS_EXTENSION).toBe(
          join(fakeHome, '.omp', 'agent', 'extensions', 'orca-agent-status.ts')
        )
        expect(
          readFileSync(
            join(fakeHome, '.omp', 'agent', 'extensions', 'orca-agent-status.ts'),
            'utf-8'
          )
        ).toContain('/hook/omp')
        expect(
          existsSync(join(fakeHome, '.pi', 'agent', 'extensions', 'orca-agent-status.ts'))
        ).toBe(false)
      } finally {
        homedirOverride.current = ''
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

        const ompAgentDir = join(fakeHome, '.omp', 'agent')
        expect(env.PI_CODING_AGENT_DIR).toBeUndefined()
        expect(env.ORCA_OMP_SOURCE_AGENT_DIR).toBe(ompAgentDir)
        expect(existsSync(join(ompAgentDir, 'auth.json'))).toBe(false)
        const extensions = readdirSync(join(ompAgentDir, 'extensions')).sort()
        expect(extensions).toEqual([
          'orca-agent-status.ts',
          'orca-prefill.ts',
          'orca-titlebar-spinner.ts'
        ])
      } finally {
        homedirOverride.current = ''
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
