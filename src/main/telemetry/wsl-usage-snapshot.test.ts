import { describe, expect, it } from 'vitest'
import { validate } from './validator'
import {
  buildWslUsageSnapshot,
  classifyLocalWslProject,
  classifyWslHostProject,
  toWslMajorMinor,
  type WslUsageSnapshotInput
} from './wsl-usage-snapshot'
import { bucketWslUsageCount } from '../../shared/telemetry-wsl-usage-event-schemas'

const baseInput: WslUsageSnapshotInput = {
  registeredDistroCount: 0,
  userDistros: [],
  wslPackageVersion: null,
  wslAvailableCached: null,
  projects: [],
  windowsDriveReposWithWslWorktrees: 0,
  wslHostsGateOpen: false
}

describe('bucketWslUsageCount', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [2, '2-5'],
    [5, '2-5'],
    [6, '6-20'],
    [20, '6-20'],
    [21, '21+'],
    [500, '21+']
  ])('%i -> %s', (count, bucket) => {
    expect(bucketWslUsageCount(count)).toBe(bucket)
  })
})

describe('toWslMajorMinor', () => {
  it('keeps major.minor only', () => {
    expect(toWslMajorMinor('2.4.13.0')).toBe('2.4')
    expect(toWslMajorMinor('2.6')).toBe('2.6')
  })
  it('drops anything not version-shaped', () => {
    expect(toWslMajorMinor(null)).toBeNull()
    expect(toWslMajorMinor('Ubuntu 2.4')).toBeNull()
    expect(toWslMajorMinor('2')).toBeNull()
  })
})

describe('classifyLocalWslProject', () => {
  it('counts a \\\\wsl$ share as inside the distro', () => {
    expect(
      classifyLocalWslProject(
        { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\app', kind: 'folder' },
        undefined
      )
    ).toEqual({ location: 'distro_fs', kind: 'folder', distro: 'Ubuntu' })
  })

  it('counts a Windows-drive project run in WSL as windows_drive', () => {
    expect(
      classifyLocalWslProject(
        { path: 'C:\\src\\app' },
        {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'p',
            distro: 'Debian',
            reason: 'project-override',
            cacheKey: 'k'
          }
        }
      )
    ).toEqual({ location: 'windows_drive', kind: 'git', distro: 'Debian' })
  })

  it('counts a WSL choice awaiting repair, and skips Windows-host projects', () => {
    expect(
      classifyLocalWslProject(
        { path: 'C:\\src\\app' },
        {
          status: 'repair-required',
          repair: {
            projectId: 'p',
            preferredRuntime: { kind: 'wsl', distro: null },
            reason: 'wsl-unavailable',
            source: 'global-default',
            cacheKey: 'k'
          }
        }
      )
    ).toEqual({ location: 'windows_drive', kind: 'git', distro: null })
    expect(
      classifyLocalWslProject(
        { path: 'C:\\src\\app' },
        {
          status: 'resolved',
          runtime: {
            kind: 'windows-host',
            hostPlatform: 'win32',
            projectId: 'p',
            reason: 'global-default',
            cacheKey: 'k'
          }
        }
      )
    ).toBeNull()
  })
})

describe('classifyWslHostProject', () => {
  it('splits /mnt/<x> from distro paths', () => {
    expect(classifyWslHostProject({ path: '/mnt/c/src/app' }, 'Ubuntu').location).toBe(
      'windows_drive'
    )
    expect(classifyWslHostProject({ path: '/home/me/app' }, 'Ubuntu').location).toBe('distro_fs')
  })
})

describe('buildWslUsageSnapshot', () => {
  it('reports buckets and booleans only, and passes the event validator', () => {
    const props = buildWslUsageSnapshot({
      registeredDistroCount: 4,
      userDistros: [
        { version: 2, state: 'running' },
        { version: 2, state: 'stopped' },
        { version: 1, state: 'stopped' }
      ],
      wslPackageVersion: '2.4.13.0',
      wslAvailableCached: true,
      projects: [
        { location: 'distro_fs', kind: 'git', distro: 'Ubuntu' },
        { location: 'distro_fs', kind: 'folder', distro: 'ubuntu' },
        { location: 'windows_drive', kind: 'git', distro: null }
      ],
      windowsDriveReposWithWslWorktrees: 1,
      wslHostsGateOpen: false
    })
    expect(props).toEqual({
      wsl_installed: true,
      wsl_version: '2.4',
      distro_registry_readable: true,
      distros_installed: '2-5',
      distros_running: '1',
      distros_wsl1: '1',
      distros_wsl2: '2-5',
      projects_wsl_total: '2-5',
      projects_wsl_distro_fs: '2-5',
      projects_wsl_windows_drive: '1',
      projects_wsl_windows_drive_wsl_worktrees: '1',
      projects_wsl_git: '2-5',
      projects_wsl_folder: '1',
      project_distros_used: '2-5',
      wsl_hosts_gate_open: false
    })
    expect(validate('wsl_usage_snapshot', props).ok).toBe(true)
  })

  it('reports no WSL and an unreadable registry without a version', () => {
    const props = buildWslUsageSnapshot({
      ...baseInput,
      registeredDistroCount: null
    })
    expect(props.wsl_installed).toBe(false)
    expect(props.distro_registry_readable).toBe(false)
    expect('wsl_version' in props).toBe(false)
    expect(validate('wsl_usage_snapshot', props).ok).toBe(true)
  })

  it('the validator rejects identifying extras', () => {
    const props = buildWslUsageSnapshot(baseInput)
    expect(validate('wsl_usage_snapshot', { ...props, distro: 'Ubuntu' }).ok).toBe(false)
    expect(validate('wsl_usage_snapshot', { ...props, wsl_version: 'Ubuntu' }).ok).toBe(false)
    expect(validate('wsl_usage_snapshot', { ...props, distros_installed: '3' }).ok).toBe(false)
  })
})
