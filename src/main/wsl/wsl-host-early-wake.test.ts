import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeWslHostDeployment } from '../../shared/wsl-host-deployment-store'
import {
  forgetWslHostToWake,
  forgetWslHostsToWake,
  rememberWslHostsToWake,
  wakeRememberedWslHosts
} from './wsl-host-early-wake'

describe('WSL host early wake', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-'))
    writeWslHostDeployment(userDataPath, 'wsl:ubuntu', {
      kind: 'wsl',
      distro: 'Ubuntu',
      localPort: 41000,
      remotePort: 6768,
      environmentId: 'wsl:ubuntu',
      createdAt: 1
    })
  })
  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('wakes only the remembered distros that are still WSL hosts', () => {
    rememberWslHostsToWake(userDataPath, ['Ubuntu', 'Removed'])
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual(['Ubuntu'])
    expect(spawn).toHaveBeenCalledExactlyOnceWith('Ubuntu')
  })

  it('wakes nothing once the open work is gone', () => {
    rememberWslHostsToWake(userDataPath, ['Ubuntu'])
    rememberWslHostsToWake(userDataPath, [])
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('wakes nothing without a list, or from an unreadable one', () => {
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    writeFileSync(join(userDataPath, 'orca-wsl-host-wake.json'), '{"version":1,"distros":["a b"]}')
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('deletes the list when WSL hosts are turned off, so the next launch wakes nothing', () => {
    rememberWslHostsToWake(userDataPath, ['Ubuntu'])
    forgetWslHostsToWake(userDataPath)
    expect(existsSync(join(userDataPath, 'orca-wsl-host-wake.json'))).toBe(false)
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    // Nothing to delete is fine too.
    expect(() => forgetWslHostsToWake(userDataPath)).not.toThrow()
  })

  it('forgets a removed host even while its record is still on disk', () => {
    rememberWslHostsToWake(userDataPath, ['Ubuntu'])
    forgetWslHostToWake(userDataPath, 'ubuntu')
    const spawn = vi.fn()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
  })
})
