import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cgroupIsInsideUserManager,
  userManagerOutlivesCaller
} from './daemon-user-manager-lifetime'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function cgroupFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cgroup-'))
  dirs.push(dir)
  const path = join(dir, 'cgroup')
  writeFileSync(path, contents)
  return path
}

const SYSTEM_SERVICE = '0::/system.slice/orca-serve.service\n'
const SSH_SESSION = '0::/user.slice/user-1000.slice/session-4.scope\n'
const DESKTOP_APP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-orca-12.scope\n'

describe('cgroupIsInsideUserManager', () => {
  it.each([
    [DESKTOP_APP, true],
    ['1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/x.scope\n', true],
    [SYSTEM_SERVICE, false],
    [SSH_SESSION, false],
    ['0::/user.slice/user-1000.slice/user@10000.service/app.slice/x.scope\n', false]
  ])('%s -> %s', (contents, expected) => {
    expect(cgroupIsInsideUserManager(contents, 1000)).toBe(expected)
  })
})

describe('userManagerOutlivesCaller', () => {
  it('trusts a caller already inside the user manager without asking logind', () => {
    const runLingerProbe = vi.fn()
    expect(
      userManagerOutlivesCaller({ uid: 1000, cgroupPath: cgroupFile(DESKTOP_APP), runLingerProbe })
    ).toBe(true)
    expect(runLingerProbe).not.toHaveBeenCalled()
  })

  it.each([SYSTEM_SERVICE, SSH_SESSION])('requires linger for a caller in %s', (contents) => {
    const log = vi.fn()
    const runLingerProbe = vi.fn(() => ({ code: 0, timedOut: false, stdout: 'yes\n' }))
    expect(
      userManagerOutlivesCaller({
        uid: 1000,
        cgroupPath: cgroupFile(contents),
        runLingerProbe,
        log
      })
    ).toBe(true)
    expect(runLingerProbe).toHaveBeenCalledWith(1000, 2_000)
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ['linger off', () => ({ code: 0, timedOut: false, stdout: 'no\n' })],
    ['unknown user', () => ({ code: 1, timedOut: false, stdout: '' })],
    ['timed out', () => ({ code: null, timedOut: true, stdout: 'yes\n' })],
    [
      'loginctl missing',
      () => {
        throw new Error('spawn loginctl ENOENT')
      }
    ]
  ])('fails closed and says why when %s', (_label, runLingerProbe) => {
    const log = vi.fn()
    expect(
      userManagerOutlivesCaller({
        uid: 1000,
        cgroupPath: cgroupFile(SYSTEM_SERVICE),
        runLingerProbe,
        log
      })
    ).toBe(false)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('daemon-scope-unavailable: linger off')
    )
  })

  it('falls back to linger when cgroup membership is unreadable', () => {
    expect(
      userManagerOutlivesCaller({
        uid: 1000,
        cgroupPath: '/definitely/missing/cgroup',
        runLingerProbe: () => ({ code: 0, timedOut: false, stdout: 'yes' })
      })
    ).toBe(true)
  })

  it('is false without a uid', () => {
    expect(userManagerOutlivesCaller({ uid: null, log: () => {} })).toBe(false)
  })
})
