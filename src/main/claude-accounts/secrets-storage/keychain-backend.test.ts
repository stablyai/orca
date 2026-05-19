import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createKeychainBackend } from './keychain-backend'

const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args)
}))

describe('keychain-backend', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('backendId === "keychain"', () => {
    expect(createKeychainBackend().backendId).toBe('keychain')
  })

  it('read returns trimmed stdout on success', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'secret-value\n', ''))
    const out = await createKeychainBackend().read('svc', 'acct')
    expect(out).toBe('secret-value')
  })

  it('read returns null when keychain reports not-found (code 44)', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(Object.assign(new Error('not found'), { code: 44 }), '', 'could not be found')
    )
    const out = await createKeychainBackend().read('svc', 'acct')
    expect(out).toBeNull()
  })

  it('write calls security add-generic-password with -U', async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      expect(args).toContain('-U')
      expect(args).toContain('add-generic-password')
      cb(null, '', '')
    })
    await createKeychainBackend().write('svc', 'acct', 'val')
    expect(execFileMock).toHaveBeenCalled()
  })

  it('delete ignores not-found', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) =>
      cb(Object.assign(new Error('nope'), { code: 44 }), '', 'could not be found')
    )
    await expect(createKeychainBackend().delete('svc', 'acct')).resolves.toBeUndefined()
  })
})
