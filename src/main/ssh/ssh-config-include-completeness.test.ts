import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateSshConfigAliasClaimCache,
  loadUserSshConfigAliasClaims,
  sshConfigMayClaimAlias
} from './ssh-config-alias-claim'
import { expandSshConfigIncludes } from './ssh-config-include-expander'
import { loadUserSshConfig } from './ssh-config-parser'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn(() => '/home/testuser')
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof OsModule>('os')
  return {
    ...actual,
    homedir: homedirMock,
    hostname: () => 'workstation.example.com',
    userInfo: () => ({ username: 'testuser', uid: 1001 })
  }
})

const tempDirs = new Set<string>()
const lockedPaths = new Set<string>()
const canRestrictFileAccess = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  invalidateSshConfigAliasClaimCache()
  for (const path of lockedPaths) {
    chmodSync(path, 0o700)
  }
  for (const path of tempDirs) {
    rmSync(path, { force: true, recursive: true })
  }
  lockedPaths.clear()
  tempDirs.clear()
})

function makeTemporaryHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'orca-ssh-include-')))
  tempDirs.add(home)
  homedirMock.mockReturnValue(home)
  return home
}

function writeFile(root: string, relativePath: string, content: string): string {
  const fullPath = join(root, relativePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}

function lockPath(path: string): void {
  chmodSync(path, 0o000)
  lockedPaths.add(path)
}

function makeHomeWithIncludeDirectory(): string {
  const home = makeTemporaryHome()
  writeFile(
    home,
    '.ssh/config',
    'Include config.d/*\n\nHost rootonly\n  HostName root.example.com\n'
  )
  mkdirSync(join(home, '.ssh', 'config.d'), { recursive: true })
  return home
}

describe('SSH config Include completeness', () => {
  it('treats absent paths and empty globs as complete', () => {
    const home = makeTemporaryHome()
    const configPath = writeFile(
      home,
      '.ssh/config',
      'Include absent.d/*\n\nHost solo\n  HostName solo.example.com\n'
    )

    expect(expandSshConfigIncludes(configPath).fullyExpanded).toBe(true)
    expect(loadUserSshConfig().map((host) => host.host)).toEqual(['solo'])
  })

  it('treats a matched directory as complete because OpenSSH reads no config from it', () => {
    const home = makeHomeWithIncludeDirectory()
    mkdirSync(join(home, '.ssh', 'config.d', 'backup'))

    expect(expandSshConfigIncludes(join(home, '.ssh', 'config')).fullyExpanded).toBe(true)
  })

  it('marks paths with unavailable substitutions as incomplete', () => {
    const home = makeTemporaryHome()
    const configPath = writeFile(
      home,
      '.ssh/config',
      'Include ${ORCA_TEST_SSH_INCLUDE_DIR}/extra.conf\n'
    )

    expect(expandSshConfigIncludes(configPath).fullyExpanded).toBe(false)
  })

  it.runIf(canRestrictFileAccess)(
    'marks an exact Include behind an unreadable directory as incomplete',
    () => {
      const home = makeTemporaryHome()
      const configPath = writeFile(
        home,
        '.ssh/config',
        'Include config.d/50-prod\n\nHost rootonly\n  HostName root.example.com\n'
      )
      writeFile(home, '.ssh/config.d/50-prod', 'Host prod\n  HostName prod.internal\n')
      lockPath(join(home, '.ssh', 'config.d'))

      const expansion = expandSshConfigIncludes(configPath)
      expect(expansion.fullyExpanded).toBe(false)
      expect(expansion.content).toContain('Host rootonly')
    }
  )

  it.runIf(canRestrictFileAccess)('marks a partial nested glob as incomplete', () => {
    const home = makeTemporaryHome()
    const configPath = writeFile(
      home,
      '.ssh/config',
      'Include config.d/*/config\n\nHost rootonly\n  HostName root.example.com\n'
    )
    writeFile(home, '.ssh/config.d/work/config', 'Host work\n  HostName work.internal\n')
    writeFile(
      home,
      '.ssh/config.d/personal/config',
      'Host personal\n  HostName personal.internal\n'
    )
    lockPath(join(home, '.ssh', 'config.d', 'personal'))

    const expansion = expandSshConfigIncludes(configPath)
    expect(expansion.fullyExpanded).toBe(false)
    expect(expansion.content).toContain('Host work')
    expect(expansion.content).not.toContain('Host personal')
    expect(sshConfigMayClaimAlias('personal', loadUserSshConfigAliasClaims())).toBe(true)
  })

  it('treats a path beneath a regular file as absent', () => {
    const home = makeTemporaryHome()
    const configPath = writeFile(home, '.ssh/config', 'Include notadir/50-prod\n')
    writeFile(home, '.ssh/notadir', 'not a directory\n')

    expect(expandSshConfigIncludes(configPath).fullyExpanded).toBe(true)
  })
})

describe('SSH config alias claim completeness', () => {
  it('caches an incomplete expansion as uncertainty until the TTL expires', () => {
    vi.useFakeTimers()
    const home = makeTemporaryHome()
    writeFile(
      home,
      '.ssh/config',
      'Include ${ORCA_TEST_SSH_INCLUDE_DIR}/extra.conf\n\nHost rootonly\n  HostName root.example.com\n'
    )

    expect(loadUserSshConfigAliasClaims()).toBeNull()
    vi.stubEnv('ORCA_TEST_SSH_INCLUDE_DIR', join(home, '.ssh', 'config.d'))
    expect(loadUserSshConfigAliasClaims()).toBeNull()

    vi.advanceTimersByTime(6_000)
    expect(loadUserSshConfigAliasClaims()).not.toBeNull()
  })

  it('proves absence after a complete expansion', () => {
    const home = makeHomeWithIncludeDirectory()
    writeFile(home, '.ssh/config.d/50-wildcard', 'Host *\n  ForwardAgent yes\n')

    expect(sshConfigMayClaimAlias('prod', loadUserSshConfigAliasClaims())).toBe(false)
  })
})
