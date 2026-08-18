import { describe, expect, it, vi } from 'vitest'
import { getDevInstanceIdentity } from '../../src/main/startup/dev-instance-identity'
import {
  DEV_SAFE_STORAGE_APP_NAME,
  ensureDevSafeStorageKeychainItem,
  getDevSafeStorageKeychainNames,
  getDevSafeStorageRepairCommand
} from './dev-safe-storage-keychain.mjs'

const GENERATED_PASSWORD = 'generated-password-should-never-leak'

function securityError(status: number | null, extra: Record<string, unknown> = {}) {
  // Node embeds the full argv in the message, which is exactly the leak this guards against.
  return Object.assign(
    new Error(
      `Command failed: /usr/bin/security add-generic-password -a A -s B -w ${GENERATED_PASSWORD} -A`
    ),
    { status, ...extra }
  )
}

function isAddCall(args: string[]) {
  return args[0] === 'add-generic-password'
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

  it('accepts a concurrently created item that is readable, without overwriting it', () => {
    // Two parallel `pnpm dev` runs race here; the loser must not clobber the winner's key.
    const run = vi.fn((args: string[]) => {
      if (isAddCall(args)) {
        throw securityError(45)
      }
    })

    expect(ensureDevSafeStorageKeychainItem({ platform: 'darwin', run })).toMatchObject({
      outcome: 'exists'
    })
    expect(run.mock.calls[0]?.[0]).not.toContain('-U')
    // The probe must not capture the password into this process, and must be scoped by account:
    // `add` collided on (service, account), so a service-only match could validate a different item.
    expect(run.mock.calls[1]?.[0]).toEqual([
      'find-generic-password',
      '-a',
      'Orca Dev Key',
      '-s',
      'Orca Dev Safe Storage',
      '-w'
    ])
  })

  it('flags an existing item whose ACL still blocks other processes', () => {
    // Regression: a run where provisioning failed lets Electron create the item bound to one
    // branch's cdhash. Reporting `exists` here would let the prompt return silently forever.
    const run = vi.fn((args: string[]) => {
      throw isAddCall(args) ? securityError(45) : securityError(null, { signal: 'SIGTERM' })
    })

    expect(ensureDevSafeStorageKeychainItem({ platform: 'darwin', run })).toMatchObject({
      outcome: 'restricted',
      service: 'Orca Dev Safe Storage'
    })
  })

  it('offers a repair that preserves the existing password', () => {
    const command = getDevSafeStorageRepairCommand()
    expect(command).toContain(
      'find-generic-password -a "Orca Dev Key" -s "Orca Dev Safe Storage" -w'
    )
    expect(command).toContain('-w "$PW" -A')
  })

  it('scopes every repair lookup by account so it cannot delete a different credential', () => {
    // Verified against a real keychain: with two items sharing a service, a service-only
    // `delete-generic-password` removes an arbitrary one.
    const command = getDevSafeStorageRepairCommand()
    expect(command).toContain(
      'delete-generic-password -a "Orca Dev Key" -s "Orca Dev Safe Storage"'
    )
    for (const subcommand of ['find-generic-password', 'delete-generic-password']) {
      const index = command.indexOf(subcommand)
      expect(command.slice(index, index + subcommand.length + 20)).toContain('-a "Orca Dev Key"')
    }
  })

  it('never returns the underlying error, which embeds the generated password', () => {
    const run = vi.fn(() => {
      throw securityError(51)
    })

    const result = ensureDevSafeStorageKeychainItem({
      platform: 'darwin',
      run,
      generatePassword: () => GENERATED_PASSWORD
    })

    expect(result).toEqual({ outcome: 'failed', service: 'Orca Dev Safe Storage', status: 51 })
    expect(JSON.stringify(result)).not.toContain(GENERATED_PASSWORD)
    expect(JSON.stringify(result)).not.toContain('Command failed')
  })

  it('degrades instead of hanging when security is killed by the timeout', () => {
    // A locked keychain makes `security` block on an unlock dialog; the timeout kills it,
    // leaving status null rather than an exit code.
    const run = vi.fn(() => {
      throw securityError(null, { signal: 'SIGTERM' })
    })

    expect(ensureDevSafeStorageKeychainItem({ platform: 'darwin', run })).toEqual({
      outcome: 'failed',
      service: 'Orca Dev Safe Storage',
      status: null
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
