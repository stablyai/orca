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
  })

  afterEach(() => {
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
