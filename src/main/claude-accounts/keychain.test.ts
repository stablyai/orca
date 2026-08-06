import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentials,
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials,
  writeActiveClaudeKeychainCredentialsForRuntime
} from './keychain'

vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

const execFileMock = vi.mocked(execFile)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
// Why: the Keychain account name is derived from the environment, so pin it here
// instead of recomputing it in every assertion — otherwise the expectations only
// hold on machines whose own username happens to take the same branch.
const TEST_KEYCHAIN_ACCOUNT = 'orca-test-user'

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
    vi.stubEnv('USER', TEST_KEYCHAIN_ACCOUNT)
    vi.stubEnv('USERNAME', TEST_KEYCHAIN_ACCOUNT)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
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
      TEST_KEYCHAIN_ACCOUNT,
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
      TEST_KEYCHAIN_ACCOUNT,
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
      TEST_KEYCHAIN_ACCOUNT,
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
        TEST_KEYCHAIN_ACCOUNT,
        '-w',
        'credentials-json'
      ],
      [
        'add-generic-password',
        '-U',
        '-s',
        'Claude Code-credentials',
        '-a',
        TEST_KEYCHAIN_ACCOUNT,
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
      TEST_KEYCHAIN_ACCOUNT,
      '-w'
    ])
  })

  it('looks up the Claude Code fallback account when $USER is not a valid keychain account', async () => {
    // Why: Claude Code rejects account names outside /^[a-zA-Z0-9._-]+$/ and stores
    // the item under 'claude-code-user' instead. Reading with the raw value misses
    // it, so account add fails with "no OAuth credentials were captured".
    vi.stubEnv('USER', 'first@example.com')
    vi.stubEnv('USERNAME', 'first@example.com')
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, 'scoped\n', '')
      return null as never
    })

    await expect(
      readActiveClaudeKeychainCredentialsStrict('/tmp/orca-claude-login-test')
    ).resolves.toBe('scoped')

    expect(execFileMock.mock.calls[0][1]).toContain('claude-code-user')
  })

  it('keeps a valid $USER as the keychain account', async () => {
    vi.stubEnv('USER', 'first.last_1-2')
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      invokeExecFileCallback(callback, null, 'scoped\n', '')
      return null as never
    })

    await readActiveClaudeKeychainCredentialsStrict('/tmp/orca-claude-login-test')

    expect(execFileMock.mock.calls[0][1]).toContain('first.last_1-2')
  })

  it('rejects when a keychain read never reports completion', async () => {
    vi.useFakeTimers()
    const configDir = '/tmp/orca-claude-login-test'
    const killMock = vi.fn()
    execFileMock.mockImplementationOnce(() => ({ kill: killMock }) as never)

    let settled = false
    let rejected: unknown
    const readPromise = readActiveClaudeKeychainCredentialsStrict(configDir).then(
      (credentials) => {
        settled = true
        return credentials
      },
      (error: unknown) => {
        settled = true
        rejected = error
        return null
      }
    )

    await vi.advanceTimersByTimeAsync(3000)

    expect(settled).toBe(true)
    await readPromise
    expect(rejected).toEqual(
      expect.objectContaining({ message: 'security timed out after 3000ms' })
    )
    expect(killMock).toHaveBeenCalled()
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
      ['delete-generic-password', '-s', scopedService, '-a', TEST_KEYCHAIN_ACCOUNT],
      ['delete-generic-password', '-s', 'Claude Code-credentials', '-a', TEST_KEYCHAIN_ACCOUNT]
    ])
  })
})
