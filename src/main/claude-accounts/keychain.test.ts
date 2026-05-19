/* eslint-disable max-lines -- test suite covers macOS keychain credential flows
plus the P4 SecretsStorage indirection cases that route through the abstraction. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetKeychainCacheForTests,
  deleteActiveClaudeKeychainCredentials,
  deleteManagedClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  readManagedClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentialsForRuntime,
  writeManagedClaudeKeychainCredentials
} from './keychain'
import { setSecretsBackendForTest } from './secrets-storage'
import { createKeychainBackend } from './secrets-storage/keychain-backend'

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

// Why: secrets-storage/index.ts imports `app` from electron at module load
// (for the production path that reads userData). Tests inject a backend via
// setSecretsBackendForTest, so we just need the import to resolve.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/orca-keychain-test' }
}))

const execFileMock = vi.mocked(execFile)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

function serviceForConfigDir(configDir: string): string {
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

function invokeExecFileCallback(
  callback: unknown,
  error: Error | null,
  stdout: string,
  stderr: string
): void {
  const execCallback = callback as (error: Error | null, stdout: string, stderr: string) => void
  execCallback(error, stdout, stderr)
}

describe('Claude Keychain credentials', () => {
  beforeEach(() => {
    setPlatform('darwin')
    execFileMock.mockReset()
    // Inject the macOS keychain backend so the test exercises the shell-out
    // path without going through selectSecretsBackend (which adds a probe).
    setSecretsBackendForTest(createKeychainBackend())
  })

  afterEach(() => {
    setSecretsBackendForTest(null)
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('reads config-scoped Claude Code 2.1 credentials before legacy credentials', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '{"claudeAiOauth":{"accessToken":"scoped"}}\n', '')
      return null as never
    })

    await expect(readActiveClaudeKeychainCredentials(configDir)).resolves.toBe(
      '{"claudeAiOauth":{"accessToken":"scoped"}}'
    )

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0][1]).toEqual([
      'find-generic-password',
      '-s',
      scopedService,
      '-a',
      process.env.USER || process.env.USERNAME || 'user',
      '-w'
    ])
  })

  it('falls back to the legacy unsuffixed Claude Code credentials service', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const notFound = Object.assign(new Error('not found'), { code: 44 })
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        invokeExecFileCallback(callback, notFound, '', 'could not be found')
        return null as never
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        invokeExecFileCallback(callback, null, 'legacy\n', '')
        return null as never
      })

    await expect(readActiveClaudeKeychainCredentials(configDir)).resolves.toBe('legacy')

    expect(execFileMock.mock.calls[1][1]).toEqual([
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-a',
      process.env.USER || process.env.USERNAME || 'user',
      '-w'
    ])
  })

  it('writes active credentials to the config-scoped Claude Code service', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '', '')
      return null as never
    })

    await writeActiveClaudeKeychainCredentials('credentials-json', configDir)

    expect(execFileMock.mock.calls[0][1]).toEqual([
      'add-generic-password',
      '-U',
      '-s',
      scopedService,
      '-a',
      process.env.USER || process.env.USERNAME || 'user',
      '-w',
      'credentials-json'
    ])
  })

  it('writes runtime credentials to scoped and legacy services for old Claude Code compatibility', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '', '')
      return null as never
    })

    await writeActiveClaudeKeychainCredentialsForRuntime('credentials-json', configDir)

    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      [
        'add-generic-password',
        '-U',
        '-s',
        scopedService,
        '-a',
        process.env.USER || process.env.USERNAME || 'user',
        '-w',
        'credentials-json'
      ],
      [
        'add-generic-password',
        '-U',
        '-s',
        'Claude Code-credentials',
        '-a',
        process.env.USER || process.env.USERNAME || 'user',
        '-w',
        'credentials-json'
      ]
    ])
  })

  it('strictly reads only the requested active credentials service', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, 'scoped\n', '')
      return null as never
    })

    await expect(readActiveClaudeKeychainCredentialsStrict(configDir)).resolves.toBe('scoped')

    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(execFileMock.mock.calls[0][1]).toEqual([
      'find-generic-password',
      '-s',
      scopedService,
      '-a',
      process.env.USER || process.env.USERNAME || 'user',
      '-w'
    ])
  })

  it('deletes both scoped and legacy active credentials for config-dir cleanup', async () => {
    const configDir = '/tmp/orca-claude-login-test'
    const scopedService = serviceForConfigDir(configDir)
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, '', '')
      return null as never
    })

    await deleteActiveClaudeKeychainCredentials(configDir)

    expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
      [
        'delete-generic-password',
        '-s',
        scopedService,
        '-a',
        process.env.USER || process.env.USERNAME || 'user'
      ],
      [
        'delete-generic-password',
        '-s',
        'Claude Code-credentials',
        '-a',
        process.env.USER || process.env.USERNAME || 'user'
      ]
    ])
  })
})

describe('managed Claude keychain LRU integration (autoplan E2)', () => {
  beforeEach(() => {
    setPlatform('darwin')
    execFileMock.mockReset()
    __resetKeychainCacheForTests()
    // Inject the macOS keychain backend so the LRU wrap-call counts still
    // line up against the existing execFile mock expectations.
    setSecretsBackendForTest(createKeychainBackend())
  })

  afterEach(() => {
    setSecretsBackendForTest(null)
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('reads from keychain on first call, then serves from cache (suppresses N+1)', async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, 'secret-1\n', '')
      return null as never
    })

    const v1 = await readManagedClaudeKeychainCredentials('a1')
    const v2 = await readManagedClaudeKeychainCredentials('a1')
    const v3 = await readManagedClaudeKeychainCredentials('a1')

    expect(v1).toBe('secret-1')
    expect(v2).toBe('secret-1')
    expect(v3).toBe('secret-1')
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('write invalidates the cached entry for that accountId', async () => {
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        invokeExecFileCallback(callback, null, 'old\n', '')
        return null as never
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        // add-generic-password
        invokeExecFileCallback(callback, null, '', '')
        return null as never
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        invokeExecFileCallback(callback, null, 'new\n', '')
        return null as never
      })

    await readManagedClaudeKeychainCredentials('a1')
    await writeManagedClaudeKeychainCredentials('a1', 'new')
    const v = await readManagedClaudeKeychainCredentials('a1')

    expect(v).toBe('new')
    // Two find-generic-password reads (cache invalidated after write) + one
    // add-generic-password write.
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('remove invalidates the cached entry for that accountId', async () => {
    execFileMock
      .mockImplementationOnce((_file, _args, _options, callback) => {
        invokeExecFileCallback(callback, null, 'val\n', '')
        return null as never
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        // delete-generic-password
        invokeExecFileCallback(callback, null, '', '')
        return null as never
      })
      .mockImplementationOnce((_file, _args, _options, callback) => {
        const notFound = Object.assign(new Error('not found'), { code: 44 })
        invokeExecFileCallback(callback, notFound, '', 'could not be found')
        return null as never
      })

    await readManagedClaudeKeychainCredentials('a1')
    await deleteManagedClaudeKeychainCredentials('a1')
    const v = await readManagedClaudeKeychainCredentials('a1')

    expect(v).toBeNull()
    // Read + delete + post-delete read (cache invalidated).
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('caches the missing/null sentinel — does not re-probe on subsequent reads', async () => {
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      const notFound = Object.assign(new Error('not found'), { code: 44 })
      invokeExecFileCallback(callback, notFound, '', 'could not be found')
      return null as never
    })

    const v1 = await readManagedClaudeKeychainCredentials('missing')
    const v2 = await readManagedClaudeKeychainCredentials('missing')

    expect(v1).toBeNull()
    expect(v2).toBeNull()
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('keychain.ts routes through the injected SecretsStorage backend (P4)', () => {
  beforeEach(() => {
    setPlatform('darwin')
    execFileMock.mockReset()
    __resetKeychainCacheForTests()
  })

  afterEach(() => {
    setSecretsBackendForTest(null)
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('readActiveClaudeKeychainCredentials uses the injected backend', async () => {
    const fake = {
      backendId: 'encrypted-file' as const,
      read: vi.fn().mockResolvedValue('encoded-creds'),
      write: vi.fn(),
      delete: vi.fn()
    }
    setSecretsBackendForTest(fake)
    expect(await readActiveClaudeKeychainCredentials('/tmp/dir')).toBe('encoded-creds')
  })

  it('writeManagedClaudeKeychainCredentials routes to backend', async () => {
    const fake = {
      backendId: 'keychain' as const,
      read: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn()
    }
    setSecretsBackendForTest(fake)
    await writeManagedClaudeKeychainCredentials('acct-1', 'token-xyz')
    expect(fake.write).toHaveBeenCalledWith(
      'Orca Claude Code Managed Credentials',
      'acct-1',
      'token-xyz'
    )
  })
})
