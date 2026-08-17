import { describe, expect, it, vi } from 'vitest'
import { getDevInstanceIdentity } from '../../src/main/startup/dev-instance-identity'
import {
  DEV_SAFE_STORAGE_APP_NAME,
  ensureDevSafeStorageKeychainItem,
  getDevSafeStorageKeychainNames
} from './dev-safe-storage-keychain.mjs'

function duplicateItemError(): Error & { status: number } {
  return Object.assign(new Error('already exists'), { status: 45 })
}

describe('dev-safe-storage-keychain', () => {
  it('provisions the key Electron derives from the dev app name', () => {
    // Contract: the runner must pre-create the exact item the main process asks for.
    expect(DEV_SAFE_STORAGE_APP_NAME).toBe(getDevInstanceIdentity(true, {}).appName)
    expect(getDevSafeStorageKeychainNames()).toEqual({
      service: 'Orca Dev Safe Storage',
      account: 'Orca Dev Key'
    })
  })

  it('never targets the packaged app key', () => {
    const packagedName = getDevInstanceIdentity(false, {}).appName
    expect(getDevSafeStorageKeychainNames().service).not.toBe(`${packagedName} Safe Storage`)
  })

  it('creates the item with an open ACL and a generated password', () => {
    const run = vi.fn()
    const result = ensureDevSafeStorageKeychainItem({
      platform: 'darwin',
      run,
      generatePassword: () => 'pw'
    })

    expect(result).toMatchObject({ outcome: 'created', service: 'Orca Dev Safe Storage' })
    expect(run).toHaveBeenCalledWith([
      'add-generic-password',
      '-a',
      'Orca Dev Key',
      '-s',
      'Orca Dev Safe Storage',
      '-w',
      'pw',
      '-A'
    ])
  })

  it('treats a concurrent creation as success without overwriting the existing key', () => {
    // Two parallel `pnpm dev` runs race here; the loser must not clobber the winner's key.
    const run = vi.fn(() => {
      throw duplicateItemError()
    })

    expect(ensureDevSafeStorageKeychainItem({ platform: 'darwin', run })).toMatchObject({
      outcome: 'exists'
    })
    expect(run.mock.calls[0]?.[0]).not.toContain('-U')
  })

  it('reports other failures without throwing', () => {
    const run = vi.fn(() => {
      throw Object.assign(new Error('keychain locked'), { status: 51 })
    })

    expect(ensureDevSafeStorageKeychainItem({ platform: 'darwin', run })).toMatchObject({
      outcome: 'failed',
      error: 'keychain locked'
    })
  })

  it('is a no-op off macOS', () => {
    const run = vi.fn()
    for (const platform of ['win32', 'linux'] as const) {
      expect(ensureDevSafeStorageKeychainItem({ platform, run })).toEqual({ outcome: 'skipped' })
    }
    expect(run).not.toHaveBeenCalled()
  })
})
