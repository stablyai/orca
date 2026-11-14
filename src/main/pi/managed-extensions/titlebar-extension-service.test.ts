import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as osModule from 'node:os'
import type * as fsModule from 'node:fs'
import { join } from 'node:path'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const userDataDir = mkdtempSync(join(tmpdir(), 'orca-pi-test-userdata-'))

// Override homedir per test without changing the eagerly created temp root.
const homedirOverride = vi.hoisted(() => ({ current: '' as string }))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: () => homedirOverride.current || actual.homedir()
  }
})
import { PiTitlebarExtensionService } from './titlebar-extension-service'

function legacySourceOverlayPath(kind: 'pi' | 'omp', sourceAgentDir: string): string {
  const rootDir = kind === 'pi' ? 'pi-agent-overlays' : 'omp-agent-overlays'
  const hashed = createHash('sha256').update(`source:${sourceAgentDir}`).digest('hex').slice(0, 32)
  return join(userDataDir, rootDir, hashed)
}

describe('PiTitlebarExtensionService', () => {
  beforeEach(() => {
    installFakeAppEnvironment({
      getPath: (name) => {
        if (name === 'userData') {
          return userDataDir
        }
        throw new Error(`unexpected app.getPath(${name})`)
      }
    })
  })

  let piHome: string

  beforeEach(() => {
    piHome = mkdtempSync(join(tmpdir(), 'orca-pi-test-pihome-'))
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

  // Windows symlinks need privileges; junction predicate tests cover ordering separately.

  describe('gentle-shell status extension', () => {
    it('materializes the status extension in userData and never creates the gentle-shell home', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'orca-gentle-shell-home-'))
      homedirOverride.current = fakeHome
      try {
        const env = new PiTitlebarExtensionService().buildGentleShellEnv()

        const extensionPath = env.ORCA_GENTLE_SHELL_STATUS_EXTENSION!
        expect(extensionPath.startsWith(userDataDir)).toBe(true)
        expect(readFileSync(extensionPath, 'utf8')).toContain('/hook/gentle-shell')
        expect(existsSync(join(fakeHome, '.gentle-shell'))).toBe(false)
        expect(existsSync(join(fakeHome, '.pi'))).toBe(false)
      } finally {
        homedirOverride.current = ''
        rmSync(fakeHome, { recursive: true, force: true })
      }
    })
  })

  describe('per-agent default source dir (no cross-agent fallback)', () => {
    it('bare-shell prep does not create missing ~/.pi or ~/.omp homes (#10196)', () => {
      const fakeHome = mkdtempSync(join(tmpdir(), 'orca-no-eager-agent-home-'))
      expect(existsSync(join(fakeHome, '.pi'))).toBe(false)
      expect(existsSync(join(fakeHome, '.omp'))).toBe(false)

      homedirOverride.current = fakeHome
      try {
        const svc = new PiTitlebarExtensionService()
        const piEnv = svc.buildPtyEnv('pty-bare-pi', undefined, 'pi', {
          materializeDefaultHome: false
        })
        const ompEnv = svc.buildPtyEnv('pty-bare-omp', undefined, 'omp', {
          materializeDefaultHome: false
        })

        expect(piEnv).toEqual({})
        expect(existsSync(join(fakeHome, '.pi'))).toBe(false)
        expect(existsSync(join(fakeHome, '.omp'))).toBe(false)
        expect(ompEnv.ORCA_OMP_SOURCE_AGENT_DIR).toBeUndefined()
        expect(ompEnv.ORCA_OMP_STATUS_EXTENSION).toEqual(
          expect.stringContaining('omp-managed-status-extension')
        )
        expect(existsSync(ompEnv.ORCA_OMP_STATUS_EXTENSION!)).toBe(true)
      } finally {
        homedirOverride.current = ''
        rmSync(fakeHome, { recursive: true, force: true })
      }
    })
  })
})
