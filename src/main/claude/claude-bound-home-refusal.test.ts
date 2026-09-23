import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ClaudeBoundHomeRefusalError,
  assertClaudeBoundHomeUsable,
  type ClaudeBoundHomeRefusal
} from './claude-bound-home-refusal'

const ROOT = mkdtempSync(join(tmpdir(), 'orca-bound-home-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const LOCAL = { executionHostId: 'local', wslDistro: null }
const SIGNED_IN_CREDENTIALS = JSON.stringify({
  claudeAiOauth: { accessToken: 'token', refreshToken: 'refresh', expiresAt: 0 }
})

function boundDir(name: string, options: { credentials?: boolean } = {}): string {
  const dir = join(ROOT, name)
  mkdirSync(dir, { recursive: true })
  if (options.credentials) {
    writeFileSync(join(dir, '.credentials.json'), SIGNED_IN_CREDENTIALS)
  }
  return dir
}

function usable(
  configDir: string,
  overrides: Partial<Parameters<typeof assertClaudeBoundHomeUsable>[0]> = {}
) {
  return assertClaudeBoundHomeUsable({
    binding: { configDir, groupId: 'group-1' },
    location: LOCAL,
    launchEnv: {},
    // Pinning the platform keeps the suite off the host's real Keychain and identical on every
    // developer machine; the `.credentials.json` half of the read is platform-independent.
    probe: { platform: 'linux' },
    ...overrides
  })
}

function refusalMessageOf(refusal: ClaudeBoundHomeRefusal): string {
  return new ClaudeBoundHomeRefusalError(refusal).message
}

async function refusalOf(promise: Promise<void>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof ClaudeBoundHomeRefusalError) {
      return error.refusal
    }
    throw error
  }
  throw new Error('expected a bound Claude home refusal')
}

describe('bound Claude home usability', () => {
  it('accepts a signed-in local directory', async () => {
    await expect(usable(boundDir('signed-in', { credentials: true }))).resolves.toBeUndefined()
  })

  it('refuses a remote execution host', async () => {
    expect(
      await refusalOf(
        usable(boundDir('remote-host', { credentials: true }), {
          location: { executionHostId: 'ssh:build-box', wslDistro: null }
        })
      )
    ).toMatchObject({ code: 'claude_bound_home_host_unsupported', groupId: 'group-1' })
  })

  it('refuses a WSL distro', async () => {
    expect(
      await refusalOf(
        usable(boundDir('wsl-host', { credentials: true }), {
          location: { executionHostId: 'local', wslDistro: 'Ubuntu' }
        })
      )
    ).toMatchObject({ code: 'claude_bound_home_host_unsupported' })
  })

  it('refuses a directory that does not exist', async () => {
    expect(await refusalOf(usable(join(ROOT, 'never-created')))).toMatchObject({
      code: 'claude_bound_home_missing',
      configDir: join(ROOT, 'never-created')
    })
  })

  it('refuses a relative binding', async () => {
    expect(await refusalOf(usable('relative/claude'))).toMatchObject({
      code: 'claude_bound_home_missing'
    })
  })

  it('refuses a directory holding no credentials', async () => {
    const dir = boundDir('signed-out')
    expect(await refusalOf(usable(dir))).toMatchObject({
      code: 'claude_bound_home_signed_out',
      configDir: dir,
      groupId: 'group-1'
    })
  })

  it('reads the config-dir-scoped Keychain item on macOS', async () => {
    const dir = boundDir('macos-signed-in')
    const read = async () => SIGNED_IN_CREDENTIALS
    await expect(
      usable(dir, { probe: { platform: 'darwin', readScopedKeychainCredentials: read } })
    ).resolves.toBeUndefined()
    expect(
      await refusalOf(
        usable(dir, {
          probe: { platform: 'darwin', readScopedKeychainCredentials: async () => null }
        })
      )
    ).toMatchObject({ code: 'claude_bound_home_signed_out' })
  })

  it('refuses a launch env naming a different config dir', async () => {
    const dir = boundDir('env-conflict', { credentials: true })
    const other = boundDir('env-conflict-other', { credentials: true })
    expect(await refusalOf(usable(dir, { launchEnv: { CLAUDE_CONFIG_DIR: other } }))).toMatchObject(
      {
        code: 'claude_bound_home_env_conflict',
        configDir: dir,
        launchEnvDir: other,
        groupId: 'group-1'
      }
    )
  })

  it('accepts a launch env naming the same config dir through a symlink alias', async () => {
    const dir = boundDir('env-match', { credentials: true })
    const alias = join(ROOT, 'env-match-alias')
    rmSync(alias, { force: true })
    symlinkSync(dir, alias, 'dir')
    await expect(usable(dir, { launchEnv: { CLAUDE_CONFIG_DIR: alias } })).resolves.toBeUndefined()
    await expect(
      usable(dir, { launchEnv: { CLAUDE_CONFIG_DIR: `${dir}  ` } })
    ).resolves.toBeUndefined()
  })

  it('refuses a `.credentials.json` that parses to no credentials', async () => {
    for (const contents of ['{}', 'not json', '', '{"claudeAiOauth":{}}']) {
      const dir = boundDir(`corrupt-${contents.length}`)
      writeFileSync(join(dir, '.credentials.json'), contents)
      expect(await refusalOf(usable(dir))).toMatchObject({ code: 'claude_bound_home_signed_out' })
    }
  })

  it('accepts a `.credentials.json` on macOS when the scoped Keychain holds nothing', async () => {
    const dir = boundDir('macos-file-only', { credentials: true })
    await expect(
      usable(dir, {
        probe: { platform: 'darwin', readScopedKeychainCredentials: async () => null }
      })
    ).resolves.toBeUndefined()
  })

  it('accepts a case-different launch env spelling on a case-insensitive filesystem', async () => {
    const dir = boundDir('Env-Case', { credentials: true })
    for (const platform of ['darwin', 'win32'] as const) {
      await expect(
        usable(dir, {
          launchEnv: { CLAUDE_CONFIG_DIR: dir.toLowerCase() },
          probe: { platform, readScopedKeychainCredentials: async () => SIGNED_IN_CREDENTIALS }
        })
      ).resolves.toBeUndefined()
    }
  })

  // A Keychain the process cannot read is not a directory that was never signed into, and
  // "sign in again" writes a second credential for an identity that is already there.
  it('refuses an unreadable Keychain as unreadable, not as signed out', async () => {
    const dir = boundDir('keychain-locked')
    const refusal = await refusalOf(
      usable(dir, {
        probe: {
          platform: 'darwin',
          readScopedKeychainCredentials: async () => {
            throw new Error('User interaction is not allowed.')
          }
        }
      })
    )

    expect(refusal).toMatchObject({
      code: 'claude_bound_home_credentials_unreadable',
      configDir: dir,
      groupId: 'group-1'
    })
    expect(refusalMessageOf(refusal)).not.toMatch(/sign in to claude under that directory/i)
  })

  it('lets a readable `.credentials.json` answer even when the Keychain is unreadable', async () => {
    const dir = boundDir('keychain-locked-file-signed-in', { credentials: true })
    await expect(
      usable(dir, {
        probe: {
          platform: 'darwin',
          readScopedKeychainCredentials: async () => {
            throw new Error('User interaction is not allowed.')
          }
        }
      })
    ).resolves.toBeUndefined()
  })

  it('names the group and the directory in the user-facing message', async () => {
    const dir = boundDir('message')
    await expect(usable(dir)).rejects.toThrow('group-1')
    await expect(usable(dir)).rejects.toThrow(dir)
  })
})
