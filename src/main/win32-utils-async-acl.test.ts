import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, runProcessSync } from '@orca/process-host'
import { setWindowsSecurityForTests } from '../shared/windows-security-addon'
import {
  createFakeWindowsSecurity,
  FAKE_USER_SID,
  type FakeWindowsSecurity
} from '../shared/windows-security-addon.test-fixture'
import { grantDirAcl, grantDirAclAsync } from './win32-utils'

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))

const USER_DIRECTORY_GRANT = {
  sid: FAKE_USER_SID,
  mask: 0x1f01ff,
  options: { inheritable: true, replace: true }
}

describe('grantDirAcl', () => {
  let fake: FakeWindowsSecurity

  beforeEach(() => {
    fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
  })

  afterEach(() => {
    // Neither grant may start a process: no icacls, no whoami.
    expect(runProcess).not.toHaveBeenCalled()
    expect(runProcessSync).not.toHaveBeenCalled()
    setWindowsSecurityForTests(null)
  })

  it('replaces the user rule with inheritable full control, by SID, in-process', () => {
    grantDirAcl('C:\\Users\\alice\\Orca')

    expect(fake.calls).toMatchObject([
      { op: 'grant', path: 'C:\\Users\\alice\\Orca', ...USER_DIRECTORY_GRANT }
    ])
  })

  it('runs the asynchronous grant on the thread pool rather than the main thread', async () => {
    await grantDirAclAsync('C:\\Users\\alice\\Orca')

    expect(fake.calls).toMatchObject([
      { op: 'grantAsync', path: 'C:\\Users\\alice\\Orca', ...USER_DIRECTORY_GRANT }
    ])
  })

  // Callers retry their write after the grant and re-throw the original EPERM if it still fails.
  it('throws a failed grant so the caller can surface its original error', async () => {
    fake.failing.add('C:\\Orca')

    expect(() => grantDirAcl('C:\\Orca')).toThrow(/Win32 error 5/)
    await expect(grantDirAclAsync('C:\\Orca')).rejects.toThrow(/Win32 error 5/)
  })

  it('is a silent no-op when the addon cannot load', async () => {
    setWindowsSecurityForTests(null)

    expect(() => grantDirAcl('C:\\Orca')).not.toThrow()
    await expect(grantDirAclAsync('C:\\Orca')).resolves.toBeUndefined()
    expect(fake.calls).toEqual([])
  })
})
