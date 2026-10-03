import type * as NodeChildProcess from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blockEventLoopUntilChildFinished,
  finishingChildScript
} from '../../shared/child-process/__fixtures__/blocked-event-loop'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

const { execFile: realExecFile } =
  await vi.importActual<typeof NodeChildProcess>('node:child_process')

import {
  deleteKeychainPassword,
  execSecurityCommand,
  isKeychainNotFoundError,
  readKeychainPassword,
  writeKeychainPassword
} from './generic-password'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function respond(stdout: string): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(null, stdout, '')
    return { kill: vi.fn() }
  })
}

function fail(error: unknown): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(error, '', '')
    return { kill: vi.fn() }
  })
}

beforeEach(() => {
  execFileMock.mockReset()
  setPlatform('darwin')
})

afterEach(() => {
  vi.useRealTimers()
  setPlatform(originalPlatform)
})

describe('readKeychainPassword', () => {
  it('returns the trimmed secret for a stored item', async () => {
    respond('  secret-value\n')
    await expect(readKeychainPassword('cursor-access-token', 'cursor-user')).resolves.toBe(
      'secret-value'
    )
    expect(execFileMock.mock.calls[0]?.[1]).toEqual([
      'find-generic-password',
      '-s',
      'cursor-access-token',
      '-a',
      'cursor-user',
      '-w'
    ])
  })

  it('returns null rather than throwing when the item does not exist', async () => {
    fail(Object.assign(new Error('The specified item could not be found'), { code: 44 }))
    await expect(readKeychainPassword('svc', 'acct')).resolves.toBeNull()
  })

  it('rethrows a denied or locked keychain so callers can report it', async () => {
    fail(new Error('User interaction is not allowed'))
    await expect(readKeychainPassword('svc', 'acct')).rejects.toThrow(
      'User interaction is not allowed'
    )
  })

  it('never shells out off macOS', async () => {
    setPlatform('win32')
    await expect(readKeychainPassword('svc', 'acct')).resolves.toBeNull()
    await writeKeychainPassword('svc', 'acct', 'value')
    await deleteKeychainPassword('svc', 'acct')
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

describe('deleteKeychainPassword', () => {
  it('swallows a missing item', async () => {
    fail(Object.assign(new Error('could not be found'), { code: 44 }))
    await expect(deleteKeychainPassword('svc', 'acct')).resolves.toBeUndefined()
  })

  it('surfaces an access failure only when the caller asks for it', async () => {
    fail(new Error('User interaction is not allowed'))
    await expect(deleteKeychainPassword('svc', 'acct')).resolves.toBeUndefined()
    await expect(
      deleteKeychainPassword('svc', 'acct', { failOnAccessError: true })
    ).rejects.toThrow('User interaction is not allowed')
  })
})

describe('isKeychainNotFoundError', () => {
  it('recognizes the security(1) not-found signals', () => {
    expect(isKeychainNotFoundError({ code: 44 })).toBe(true)
    expect(isKeychainNotFoundError(new Error('The specified item could not be found'))).toBe(true)
    expect(isKeychainNotFoundError(new Error('User interaction is not allowed'))).toBe(false)
  })
})

describe('execSecurityCommand timeout', () => {
  it('resolves a security call that finished while the event loop was blocked past the limit', async () => {
    const markerDir = mkdtempSync(join(tmpdir(), 'orca-keychain-blocked-'))
    try {
      const marker = join(markerDir, 'finished')
      execFileMock.mockImplementation((_file, _args, options, callback) =>
        realExecFile(
          process.execPath,
          ['-e', finishingChildScript(marker, 'secret-value')],
          options,
          callback
        )
      )
      const pending = readKeychainPassword('svc', 'acct')
      blockEventLoopUntilChildFinished(marker, 3_100)

      await expect(pending).resolves.toBe('secret-value')
    } finally {
      rmSync(markerDir, { recursive: true, force: true })
    }
  }, 15_000)

  it('kills a security call that is still running at the limit and rejects with ETIMEDOUT', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    execFileMock.mockImplementation(() => ({ kill, exitCode: null, signalCode: null }))
    const rejection = expect(execSecurityCommand(['find-generic-password'])).rejects.toMatchObject({
      message: 'security timed out after 3000ms',
      code: 'ETIMEDOUT',
      stderr: ''
    })

    await vi.advanceTimersByTimeAsync(3_001)

    await rejection
    expect(kill).toHaveBeenCalled()
  })

  it("does not pass execFile's own timeout, which would drop a late child's stdout", async () => {
    respond('value')
    await readKeychainPassword('svc', 'acct')
    expect(execFileMock.mock.calls[0]?.[2]).not.toHaveProperty('timeout')
  })
})

describe('secret redaction', () => {
  const SECRET = '{"claudeAiOauth":{"accessToken":"sk-ant-oat-leak-canary"}}'

  async function rejectedWrite(): Promise<unknown> {
    return writeKeychainPassword('svc', 'acct', SECRET).then(
      () => {
        throw new Error('expected the write to fail')
      },
      (error: unknown) => error
    )
  }

  function expectNoSecret(error: unknown): void {
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(SECRET)
    expect(String(error instanceof Error ? error.stack : '')).not.toContain(SECRET)
    expect(inspect(error, { depth: 5 })).not.toContain(SECRET)
    expect(inspect(error, { depth: 5 })).toContain('<redacted>')
  }

  it('removes the -w value from a failed write', async () => {
    execFileMock.mockImplementation((_file, args: string[], options, callback) =>
      realExecFile(process.execPath, ['-e', 'process.exit(1)', '--', ...args], options, callback)
    )
    expectNoSecret(await rejectedWrite())
  })

  it('removes the -w value from a spawn failure', async () => {
    execFileMock.mockImplementation((_file, args: string[], options, callback) =>
      realExecFile('orca-missing-security-binary', args, options, callback)
    )
    expectNoSecret(await rejectedWrite())
  })
})
