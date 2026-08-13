import { describe, expect, it, beforeEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetLegacyTerminalShimRemovalForTests,
  removeLegacyTerminalShimDir,
  stripLegacyTerminalShimEnv
} from './legacy-terminal-shim-dir'

describe('legacy terminal shim removal', () => {
  beforeEach(() => {
    __resetLegacyTerminalShimRemovalForTests()
  })

  it('deletes the orphaned wrapper directory left by older installs', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-legacy-shim-'))
    const shimDir = join(userData, 'orca-terminal-attribution', 'posix')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, 'git'), '#!/usr/bin/env bash\n')

    removeLegacyTerminalShimDir(userData)

    expect(existsSync(join(userData, 'orca-terminal-attribution'))).toBe(false)
    expect(existsSync(userData)).toBe(true)
  })

  it('does not throw when nothing is left to remove', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-legacy-shim-'))
    expect(() => removeLegacyTerminalShimDir(userData)).not.toThrow()
  })

  it('drops inherited shim env and its PATH entry without touching real entries', () => {
    // Why: a daemon predating the removal reseeds these from its own process.env.
    const env: Record<string, string> = {
      PATH: `/home/u/.orca/orca-terminal-attribution/posix:/usr/local/bin:/usr/bin`,
      ORCA_ENABLE_GIT_ATTRIBUTION: '1',
      ORCA_GIT_COMMIT_TRAILER: 'Co-authored-by: Orca <help@stably.ai>',
      ORCA_GH_PR_FOOTER: 'footer',
      ORCA_GH_ISSUE_FOOTER: 'footer',
      ORCA_ATTRIBUTION_SHIM_DIR: '/home/u/.orca/orca-terminal-attribution/posix',
      ORCA_REAL_GIT: '/usr/bin/git',
      ORCA_REAL_GH: '/usr/bin/gh',
      HOME: '/home/u'
    }

    stripLegacyTerminalShimEnv(env, 'linux')

    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(env.ORCA_ENABLE_GIT_ATTRIBUTION).toBeUndefined()
    expect(env.ORCA_GIT_COMMIT_TRAILER).toBeUndefined()
    expect(env.ORCA_GH_PR_FOOTER).toBeUndefined()
    expect(env.ORCA_GH_ISSUE_FOOTER).toBeUndefined()
    expect(env.ORCA_ATTRIBUTION_SHIM_DIR).toBeUndefined()
    expect(env.ORCA_REAL_GIT).toBeUndefined()
    expect(env.ORCA_REAL_GH).toBeUndefined()
    expect(env.HOME).toBe('/home/u')
  })

  it('strips the Windows shim entry on the inherited Path spelling', () => {
    const env: Record<string, string> = {
      Path: `C:\\Users\\u\\AppData\\Roaming\\Orca\\orca-terminal-attribution\\win32;C:\\Windows\\System32`
    }

    stripLegacyTerminalShimEnv(env, 'win32')

    expect(env.Path).toBe('C:\\Windows\\System32')
  })

  it('matches a re-cased shim entry on case-insensitive filesystems', () => {
    const env: Record<string, string> = {
      Path: `C:\\Users\\u\\AppData\\Roaming\\Orca\\Orca-Terminal-Attribution\\win32;C:\\Windows\\System32`
    }

    stripLegacyTerminalShimEnv(env, 'win32')

    expect(env.Path).toBe('C:\\Windows\\System32')
  })

  it('keeps neighbouring directories that merely share the name prefix', () => {
    const env: Record<string, string> = {
      PATH: '/opt/orca-terminal-attribution:/home/u/orca-terminal-attribution-notes/bin:/usr/bin'
    }

    stripLegacyTerminalShimEnv(env, 'linux')

    expect(env.PATH).toBe(
      '/opt/orca-terminal-attribution:/home/u/orca-terminal-attribution-notes/bin:/usr/bin'
    )
  })

  it('leaves an unrelated PATH untouched', () => {
    const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin' }
    stripLegacyTerminalShimEnv(env, 'linux')
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin')
  })
})
