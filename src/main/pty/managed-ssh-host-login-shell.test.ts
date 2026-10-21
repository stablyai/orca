import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveManagedSshHostLoginShell } from './managed-ssh-host-login-shell'

const hostPlatform = process.platform
const MANAGED = { ORCA_ORCAD_MANAGED_ACTIVATION_ROOT: 'C:\\Users\\u\\.orca-remote' }
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const exists = () => true

describe('resolveManagedSshHostLoginShell', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  })

  it('returns an existing PowerShell-family DefaultShell on a managed SSH host', () => {
    expect(resolveManagedSshHostLoginShell(MANAGED, exists, () => PWSH)).toBe(PWSH)
  })

  it('never reads the registry for a desktop or user-started server', () => {
    const read = () => {
      throw new Error('must not read DefaultShell')
    }
    expect(resolveManagedSshHostLoginShell({}, exists, read)).toBeUndefined()
  })

  it('ignores a missing file and shells whose quoting family differs', () => {
    expect(
      resolveManagedSshHostLoginShell(
        MANAGED,
        () => false,
        () => PWSH
      )
    ).toBeUndefined()
    for (const shell of [
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      ''
    ]) {
      expect(resolveManagedSshHostLoginShell(MANAGED, exists, () => shell)).toBeUndefined()
    }
  })
})
