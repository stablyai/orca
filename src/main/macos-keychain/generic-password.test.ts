import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  deleteKeychainPassword,
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
