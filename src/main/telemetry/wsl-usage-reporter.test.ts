import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackMock = vi.hoisted(() => vi.fn(() => true))
vi.mock('./client', () => ({
  track: trackMock,
  isTelemetryEnabled: () => true
}))

import {
  collectWslProjects,
  listRunningDistrosForSnapshot,
  WSL_USAGE_SNAPSHOT_INTERVAL_MS,
  WslUsageReporter,
  type WslUsageStore
} from './wsl-usage-reporter'
import type { WslUsageSnapshotInput } from './wsl-usage-snapshot'

const input: WslUsageSnapshotInput = {
  registeredDistroCount: 1,
  userDistros: [{ version: 2, state: 'running' }],
  wslPackageVersion: '2.4.13',
  wslAvailableCached: true,
  projects: [],
  wslHostsGateOpen: false
}

const store: WslUsageStore = {
  getRepos: () => [],
  getProjects: () => [],
  getSettings: () => ({})
}

describe('WslUsageReporter', () => {
  let dir: string
  let now: number
  const gather = vi.fn(async () => input)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wsl-usage-'))
    now = 1_000_000_000_000
    trackMock.mockClear()
    trackMock.mockReturnValue(true)
    gather.mockClear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function reporter(overrides: Partial<ConstructorParameters<typeof WslUsageReporter>[2]> = {}) {
    return new WslUsageReporter(store, dir, {
      platform: 'win32',
      now: () => now,
      telemetryEnabled: () => true,
      gather,
      ...overrides
    })
  }

  it('sends once, then not again within a day, across restarts', async () => {
    expect(await reporter().reportIfDue()).toBe(true)
    expect(trackMock).toHaveBeenCalledWith('wsl_usage_snapshot', expect.any(Object))
    const stamp: unknown = JSON.parse(readFileSync(join(dir, 'wsl-usage-telemetry.json'), 'utf8'))
    expect(stamp).toEqual({ lastSentAt: now })

    now += WSL_USAGE_SNAPSHOT_INTERVAL_MS - 1
    expect(await reporter().reportIfDue()).toBe(false)
    expect(gather).toHaveBeenCalledTimes(1)

    now += 1
    expect(await reporter().reportIfDue()).toBe(true)
    expect(gather).toHaveBeenCalledTimes(2)
  })

  it('gathers nothing off Windows or while telemetry is off', async () => {
    expect(await reporter({ platform: 'darwin' }).reportIfDue()).toBe(false)
    expect(await reporter({ platform: 'linux' }).reportIfDue()).toBe(false)
    expect(await reporter({ telemetryEnabled: () => false }).reportIfDue()).toBe(false)
    expect(gather).not.toHaveBeenCalled()
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('does not regather an hour after a failed gather', async () => {
    gather.mockRejectedValueOnce(new Error('store unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instance = reporter()
    expect(await instance.reportIfDue()).toBe(false)
    now += 60 * 60 * 1000
    expect(await instance.reportIfDue()).toBe(false)
    expect(gather).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('treats a stamp from the future as due', async () => {
    writeFileSync(join(dir, 'wsl-usage-telemetry.json'), JSON.stringify({ lastSentAt: now + 1e9 }))
    expect(await reporter().reportIfDue()).toBe(true)
  })

  it('stamps a dropped send so the gather is not repaid hourly', async () => {
    trackMock.mockReturnValue(false)
    const instance = reporter()
    expect(await instance.reportIfDue()).toBe(false)
    now += 60 * 60 * 1000
    expect(await instance.reportIfDue()).toBe(false)
    expect(gather).toHaveBeenCalledTimes(1)
  })

  it('treats a corrupt stamp as never sent', async () => {
    writeFileSync(join(dir, 'wsl-usage-telemetry.json'), 'not json')
    expect(await reporter().reportIfDue()).toBe(true)
  })

  it('never throws when gathering fails', async () => {
    gather.mockRejectedValueOnce(new Error('reg.exe timed out'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await reporter().reportIfDue()).toBe(false)
    warn.mockRestore()
  })
})

describe('listRunningDistrosForSnapshot', () => {
  it('reuses a confirmed list without probing', async () => {
    const probe = vi.fn(async () => ['Other'])
    const running = await listRunningDistrosForSnapshot(
      [{ distro: 'Ubuntu' }],
      () => ['Ubuntu'],
      probe
    )
    expect(running).toEqual(['Ubuntu'])
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes once when nothing is cached and a user distro exists', async () => {
    const probe = vi.fn(async () => ['Ubuntu'])
    const running = await listRunningDistrosForSnapshot([{ distro: 'Ubuntu' }], () => null, probe)
    expect(running).toEqual(['Ubuntu'])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('never probes without a user distro', async () => {
    const probe = vi.fn(async () => [])
    await listRunningDistrosForSnapshot([{ distro: 'docker-desktop' }], () => null, probe)
    await listRunningDistrosForSnapshot(null, () => null, probe)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('collectWslProjects', () => {
  const wslStore: WslUsageStore = {
    getRepos: () => [
      {
        id: 'a',
        path: '\\\\wsl$\\Ubuntu\\home\\me\\a',
        displayName: 'a',
        badgeColor: '',
        addedAt: 0
      },
      {
        id: 'c',
        path: '/mnt/d/src/c',
        displayName: 'c',
        badgeColor: '',
        addedAt: 0,
        kind: 'folder',
        executionHostId: 'runtime:env-1'
      }
    ],
    getProjects: () => [],
    getSettings: () => ({})
  }

  it('skips WSL-host projects while the gate is closed, without reading environments', () => {
    const readHostDistros = vi.fn(() => new Map([['env-1', 'Debian']]))
    expect(collectWslProjects(wslStore, false, readHostDistros, 'Ubuntu')).toEqual([
      { location: 'distro_fs', kind: 'git', distro: 'Ubuntu' }
    ])
    expect(readHostDistros).not.toHaveBeenCalled()
  })

  it('counts a WSL-host project on a Windows drive when the gate is open', () => {
    const projects = collectWslProjects(wslStore, true, () => new Map([['env-1', 'Debian']]), null)
    expect(projects).toContainEqual({ location: 'windows_drive', kind: 'folder', distro: 'Debian' })
  })
})
