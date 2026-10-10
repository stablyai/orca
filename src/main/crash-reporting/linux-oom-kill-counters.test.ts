import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  linuxOomKillDetails,
  readLinuxOomKillCounters,
  setLinuxOomKillDaemonPidSource,
  setLinuxOomKillFileReaderForTest
} from './linux-oom-kill-counters'
import {
  preGoneLinuxOomKillDetails,
  resetPreGoneSystemMemorySamplingForTest,
  samplePreGoneSystemMemory
} from './pre-gone-host-memory'
import { setSystemMemoryInfoReaderForTest } from './system-memory-details'
import { setSwapVolumeFreeSpaceReaderForTest } from './swap-volume-free-space'

// Paths and contents as read on Ubuntu 24.04 (WSL2 kernel 6.18) during the scan-35 repro.
const SCOPE = '/user.slice/user-1000.slice/user@1000.service/app.slice/orca.scope'
const DAEMON_SCOPE = '/user.slice/user-1000.slice/user@1000.service/app.slice/orca-daemon-n1.scope'
const DAEMON_PID = 4242

function fakeHost(state: {
  hostKills: number
  cgroupKills: number
  memoryMax?: string
  sliceOomEvents?: number
  sliceLocalOomEvents?: number
  scopeMemoryMax?: string
  scopeLocalOomEvents?: number
  userSliceMemoryMax?: string
  userSliceLocalOomEvents?: number
  daemonCgroup?: string
  daemonKills?: number
}) {
  return (path: string): string | undefined => {
    switch (path) {
      case `/proc/${DAEMON_PID}/cgroup`:
        return state.daemonCgroup ? `0::${state.daemonCgroup}\n` : undefined
      case `/sys/fs/cgroup${DAEMON_SCOPE}/memory.events`:
        return `oom 0\noom_kill ${state.daemonKills ?? 0}\n`
      case '/proc/vmstat':
        return `pgfault 123\noom_kill ${state.hostKills}\npgmajfault 4\n`
      case '/proc/self/cgroup':
        return `0::${SCOPE}\n`
      case `/sys/fs/cgroup${SCOPE}/memory.events`:
        return `low 0\nhigh 0\nmax 12\noom 1\noom_kill ${state.cgroupKills}\noom_group_kill 0\n`
      case `/sys/fs/cgroup${SCOPE}/memory.max`:
        return state.scopeMemoryMax ?? 'max\n'
      case `/sys/fs/cgroup${SCOPE}/memory.events.local`:
        return `max 0\noom ${state.scopeLocalOomEvents ?? 0}\noom_kill 0\n`
      case '/sys/fs/cgroup/user.slice/memory.max':
        return state.userSliceMemoryMax ?? 'max\n'
      case '/sys/fs/cgroup/user.slice/memory.events.local':
        return `max 0\noom ${state.userSliceLocalOomEvents ?? 0}\noom_kill 0\n`
      case '/sys/fs/cgroup/user.slice/user-1000.slice/memory.max':
        return state.memoryMax ?? 'max\n'
      case '/sys/fs/cgroup/user.slice/user-1000.slice/memory.events':
        return `low 0\nhigh 0\nmax 40\noom ${state.sliceOomEvents ?? 0}\noom_kill 0\n`
      case '/sys/fs/cgroup/user.slice/user-1000.slice/memory.events.local':
        return `low 0\nhigh 0\nmax 40\noom ${state.sliceLocalOomEvents ?? 0}\noom_kill 0\n`
      case '/proc/pressure/memory':
        return 'some avg10=42.50 avg60=10.00 avg300=2.00 total=1\nfull avg10=30.00 avg60=0 avg300=0 total=1\n'
      default:
        return undefined
    }
  }
}

function readCountersOrThrow() {
  const counters = readLinuxOomKillCounters()
  if (!counters) {
    throw new Error('expected Linux counters')
  }
  return counters
}

afterEach(() => {
  setLinuxOomKillFileReaderForTest(null)
  setLinuxOomKillDaemonPidSource(null)
})

describe('readLinuxOomKillCounters', () => {
  it('returns null off Linux', () => {
    setLinuxOomKillFileReaderForTest(fakeHost({ hostKills: 1, cgroupKills: 1 }), 'darwin')
    expect(readLinuxOomKillCounters()).toBeNull()
  })

  it('reads host and cgroup counters, PSI, and the nearest ancestor memory limit', () => {
    setLinuxOomKillFileReaderForTest(
      fakeHost({
        hostKills: 3,
        cgroupKills: 1,
        memoryMax: `${8 * 1024 * 1024 * 1024}\n`,
        sliceOomEvents: 5,
        sliceLocalOomEvents: 2
      }),
      'linux'
    )
    expect(readLinuxOomKillCounters()).toEqual({
      vmstatOomKill: 3,
      cgroupOomKill: 1,
      cgroupLeafKind: 'orca',
      cgroupMemoryMaxMB: 8192,
      memoryLimits: [
        { dir: '/sys/fs/cgroup/user.slice/user-1000.slice', maxMB: 8192, localOomEvents: 2 }
      ],
      memoryPressureSomeAvg10: 42.5
    })
  })

  it('reads the terminal daemon scope separately when it is a sibling of Orca main', () => {
    setLinuxOomKillDaemonPidSource(() => DAEMON_PID)
    setLinuxOomKillFileReaderForTest(
      fakeHost({
        hostKills: 3,
        cgroupKills: 0,
        daemonCgroup: DAEMON_SCOPE,
        daemonKills: 2
      }),
      'linux'
    )
    expect(readLinuxOomKillCounters()).toMatchObject({
      daemonSharesCgroup: false,
      daemonCgroupPath: DAEMON_SCOPE,
      daemonCgroupOomKill: 2
    })
  })

  it('marks an unscoped daemon as sharing Orca main cgroup', () => {
    setLinuxOomKillDaemonPidSource(() => DAEMON_PID)
    setLinuxOomKillFileReaderForTest(
      fakeHost({ hostKills: 3, cgroupKills: 0, daemonCgroup: SCOPE }),
      'linux'
    )
    const counters = readLinuxOomKillCounters()
    expect(counters).toMatchObject({ daemonSharesCgroup: true })
    expect(counters).not.toHaveProperty('daemonCgroupPath')
  })

  it('reads the daemon pid source once while the daemon stays in its cgroup', () => {
    const pidSource = vi.fn(() => DAEMON_PID)
    setLinuxOomKillDaemonPidSource(pidSource)
    const state: { hostKills: number; cgroupKills: number; daemonCgroup?: string } = {
      hostKills: 3,
      cgroupKills: 0,
      daemonCgroup: DAEMON_SCOPE
    }
    setLinuxOomKillFileReaderForTest(fakeHost(state), 'linux')
    readLinuxOomKillCounters()
    readLinuxOomKillCounters()
    expect(pidSource).toHaveBeenCalledTimes(1)
    state.daemonCgroup = undefined
    readLinuxOomKillCounters()
    expect(pidSource).toHaveBeenCalledTimes(2)
  })

  it('ignores a daemon pid whose cgroup is not an Orca daemon scope (recycled pid)', () => {
    setLinuxOomKillDaemonPidSource(() => DAEMON_PID)
    setLinuxOomKillFileReaderForTest(
      fakeHost({
        hostKills: 3,
        cgroupKills: 0,
        daemonCgroup: '/system.slice/cron.service'
      }),
      'linux'
    )
    const counters = readLinuxOomKillCounters()
    expect(counters).not.toHaveProperty('daemonSharesCgroup')
    expect(counters).not.toHaveProperty('daemonCgroupOomKill')
  })

  it.each([
    ['/user.slice/user-1000.slice/session-3.scope', 'login-session'],
    ['/user.slice/user-1000.slice/user@1000.service/app.slice/app-Alacritty-9.scope', 'other'],
    ['/', 'root']
  ])('classifies a cgroup leaf of %s as %s', (cgroup, kind) => {
    const host = fakeHost({ hostKills: 0, cgroupKills: 0 })
    setLinuxOomKillFileReaderForTest(
      (path) => (path === '/proc/self/cgroup' ? `0::${cgroup}\n` : host(path)),
      'linux'
    )
    expect(readLinuxOomKillCounters()).toMatchObject({ cgroupLeafKind: kind })
  })

  it('degrades to the host counter on a cgroup v1-only host', () => {
    const host = fakeHost({ hostKills: 2, cgroupKills: 0 })
    setLinuxOomKillFileReaderForTest(
      (path) => (path === '/proc/self/cgroup' ? '4:memory:/user.slice\n' : host(path)),
      'linux'
    )
    expect(readLinuxOomKillCounters()).toEqual({
      vmstatOomKill: 2,
      memoryPressureSomeAvg10: 42.5
    })
  })
})

describe('linuxOomKillDetails', () => {
  it('names a memcg-limit kill of an Orca process even when the host counter also moved', () => {
    expect(
      linuxOomKillDetails(
        {
          vmstatOomKill: 5,
          cgroupOomKill: 0,
          cgroupMemoryMaxMB: 600,
          memoryLimits: [{ dir: '/s', maxMB: 600, localOomEvents: 3 }],
          memoryPressureSomeAvg10: 61
        },
        12_000,
        {
          vmstatOomKill: 6,
          cgroupOomKill: 1,
          cgroupLeafKind: 'orca',
          cgroupMemoryMaxMB: 600,
          memoryLimits: [{ dir: '/s', maxMB: 600, localOomEvents: 4 }]
        }
      )
    ).toEqual({
      linuxOomKillBaselineAgeMs: 12_000,
      linuxOomKillHostDelta: 1,
      linuxOomKillCgroupDelta: 1,
      linuxOomKillCgroupLeafKind: 'orca',
      linuxOomKillVerdict: 'orca-cgroup-oom-kill',
      linuxOomKillScope: 'memcg-limit',
      linuxCgroupMemoryMaxMB: 600,
      linuxMemoryPressurePreGoneSomeAvg10: 61
    })
  })

  it('scopes an Orca process kill as global when no memory limit was reached', () => {
    expect(
      linuxOomKillDetails({ vmstatOomKill: 5, cgroupOomKill: 0 }, 5_000, {
        vmstatOomKill: 6,
        cgroupOomKill: 1,
        cgroupLeafKind: 'orca'
      })
    ).toMatchObject({
      linuxOomKillVerdict: 'orca-cgroup-oom-kill',
      linuxOomKillScope: 'global'
    })
    expect(
      linuxOomKillDetails(
        {
          vmstatOomKill: 5,
          cgroupOomKill: 0,
          cgroupMemoryMaxMB: 8192,
          memoryLimits: [{ dir: '/s', maxMB: 8192, localOomEvents: 2 }]
        },
        5_000,
        {
          vmstatOomKill: 6,
          cgroupOomKill: 1,
          cgroupLeafKind: 'orca',
          cgroupMemoryMaxMB: 8192,
          memoryLimits: [{ dir: '/s', maxMB: 8192, localOomEvents: 2 }]
        }
      )
    ).toMatchObject({
      linuxOomKillVerdict: 'orca-cgroup-oom-kill',
      linuxOomKillScope: 'global'
    })
  })

  it('names a memcg-limit kill by a tighter limit further up the tree', () => {
    const GiB = 1024 * 1024 * 1024
    const host = {
      hostKills: 5,
      cgroupKills: 0,
      scopeMemoryMax: `${8 * GiB}\n`,
      userSliceMemoryMax: `${4 * GiB}\n`,
      userSliceLocalOomEvents: 0
    }
    setLinuxOomKillFileReaderForTest(fakeHost(host), 'linux')
    const before = readCountersOrThrow()
    setLinuxOomKillFileReaderForTest(
      fakeHost({ ...host, hostKills: 6, cgroupKills: 1, userSliceLocalOomEvents: 1 }),
      'linux'
    )
    expect(linuxOomKillDetails(before, 10_000, readCountersOrThrow())).toMatchObject({
      linuxOomKillVerdict: 'orca-cgroup-oom-kill',
      linuxOomKillScope: 'memcg-limit',
      linuxCgroupMemoryMaxMB: 4096
    })
  })

  it('scopes as global when only a sibling hit its own limit under the limited slice', () => {
    const host = {
      hostKills: 5,
      cgroupKills: 0,
      memoryMax: `${4 * 1024 * 1024 * 1024}\n`,
      sliceOomEvents: 0,
      sliceLocalOomEvents: 0
    }
    setLinuxOomKillFileReaderForTest(fakeHost(host), 'linux')
    const before = readCountersOrThrow()
    // Hierarchical `oom` moved from the sibling; the slice's local count did not.
    setLinuxOomKillFileReaderForTest(
      fakeHost({ ...host, hostKills: 7, cgroupKills: 1, sliceOomEvents: 1 }),
      'linux'
    )
    expect(linuxOomKillDetails(before, 10_000, readCountersOrThrow())).toMatchObject({
      linuxOomKillVerdict: 'orca-cgroup-oom-kill',
      linuxOomKillScope: 'global'
    })
  })

  it.each([
    ['a login-session leaf', { cgroupLeafKind: 'login-session' as const }],
    ['an unrecognised leaf', { cgroupLeafKind: 'other' as const }],
    ['an unknown leaf', {}],
    [
      'a cgroup shared with the daemon',
      { cgroupLeafKind: 'orca' as const, daemonSharesCgroup: true }
    ]
  ])('does not pin a kill in %s on Orca', (_label, leaf) => {
    expect(
      linuxOomKillDetails({ vmstatOomKill: 5, cgroupOomKill: 0 }, 5_000, {
        vmstatOomKill: 6,
        cgroupOomKill: 1,
        ...leaf
      })
    ).toMatchObject({
      linuxOomKillVerdict: 'shared-cgroup-oom-kill',
      linuxOomKillScope: 'global'
    })
  })

  it('treats the cgroup as shared when only the baseline saw the daemon in it', () => {
    expect(
      linuxOomKillDetails({ vmstatOomKill: 5, cgroupOomKill: 0, daemonSharesCgroup: true }, 5_000, {
        vmstatOomKill: 6,
        cgroupOomKill: 1,
        cgroupLeafKind: 'orca'
      })
    ).toMatchObject({ linuxOomKillVerdict: 'shared-cgroup-oom-kill' })
  })

  it('clears Orca when the host counter moved but its readable cgroup counter did not', () => {
    const before = {
      vmstatOomKill: 0,
      cgroupOomKill: 0,
      daemonSharesCgroup: true
    }
    const details = linuxOomKillDetails(before, 5_000, {
      ...before,
      vmstatOomKill: 1
    })
    expect(details).toMatchObject({
      linuxOomKillHostDelta: 1,
      linuxOomKillCgroupDelta: 0,
      linuxOomKillVerdict: 'oom-kill-outside-orca-cgroups'
    })
    expect(details).not.toHaveProperty('linuxOomKillScope')
  })

  it('clears Orca and the daemon scope when the compared daemon counter did not move', () => {
    const before = {
      vmstatOomKill: 5,
      cgroupOomKill: 0,
      daemonSharesCgroup: false,
      daemonCgroupPath: DAEMON_SCOPE,
      daemonCgroupOomKill: 0
    }
    expect(linuxOomKillDetails(before, 5_000, { ...before, vmstatOomKill: 6 })).toMatchObject({
      linuxOomKillDaemonCgroupDelta: 0,
      linuxOomKillVerdict: 'oom-kill-outside-orca-cgroups'
    })
  })

  it('leaves the kill unattributed when the baseline never saw the daemon', () => {
    expect(
      linuxOomKillDetails({ vmstatOomKill: 0, cgroupOomKill: 0 }, 5_000, {
        vmstatOomKill: 1,
        cgroupOomKill: 0
      })
    ).toMatchObject({ linuxOomKillVerdict: 'host-oom-kill-unattributed' })
  })

  it('leaves the kill unattributed when a daemon scope appeared after the baseline', () => {
    const details = linuxOomKillDetails({ vmstatOomKill: 0, cgroupOomKill: 0 }, 5_000, {
      vmstatOomKill: 1,
      cgroupOomKill: 0,
      daemonSharesCgroup: false,
      daemonCgroupPath: DAEMON_SCOPE,
      daemonCgroupOomKill: 0
    })
    expect(details).not.toHaveProperty('linuxOomKillDaemonCgroupDelta')
    expect(details).toMatchObject({
      linuxOomKillVerdict: 'host-oom-kill-unattributed'
    })
  })

  it('leaves the kill unattributed when a shared daemon moved into its own scope', () => {
    expect(
      linuxOomKillDetails({ vmstatOomKill: 0, cgroupOomKill: 0, daemonSharesCgroup: true }, 5_000, {
        vmstatOomKill: 1,
        cgroupOomKill: 0,
        daemonSharesCgroup: false,
        daemonCgroupPath: DAEMON_SCOPE,
        daemonCgroupOomKill: 0
      })
    ).toMatchObject({ linuxOomKillVerdict: 'host-oom-kill-unattributed' })
  })

  it('names a kill in the terminal daemon scope as a daemon-cgroup kill', () => {
    const before = {
      vmstatOomKill: 5,
      cgroupOomKill: 0,
      cgroupLeafKind: 'orca' as const,
      daemonSharesCgroup: false,
      daemonCgroupPath: DAEMON_SCOPE,
      daemonCgroupOomKill: 0
    }
    const details = linuxOomKillDetails(before, 5_000, {
      ...before,
      vmstatOomKill: 6,
      daemonCgroupOomKill: 1
    })
    expect(details).toMatchObject({
      linuxOomKillCgroupDelta: 0,
      linuxOomKillDaemonCgroupDelta: 1,
      linuxOomKillDaemonSharesCgroup: false,
      linuxOomKillCgroupLeafKind: 'orca',
      linuxOomKillVerdict: 'daemon-cgroup-oom-kill'
    })
    expect(details).not.toHaveProperty('linuxOomKillScope')
  })

  it('leaves the kill unattributed when the baseline daemon scope cannot be compared', () => {
    const details = linuxOomKillDetails(
      {
        vmstatOomKill: 5,
        cgroupOomKill: 0,
        daemonCgroupPath: '/a/orca-daemon-old.scope',
        daemonCgroupOomKill: 4
      },
      5_000,
      {
        vmstatOomKill: 6,
        cgroupOomKill: 0,
        daemonCgroupPath: DAEMON_SCOPE,
        daemonCgroupOomKill: 0
      }
    )
    expect(details).not.toHaveProperty('linuxOomKillDaemonCgroupDelta')
    expect(details).toMatchObject({
      linuxOomKillVerdict: 'host-oom-kill-unattributed'
    })
  })

  it('leaves a host-only kill unattributed when Orca has no readable cgroup counter', () => {
    expect(linuxOomKillDetails({ vmstatOomKill: 0 }, 5_000, { vmstatOomKill: 1 })).toMatchObject({
      linuxOomKillHostDelta: 1,
      linuxOomKillVerdict: 'host-oom-kill-unattributed'
    })
  })

  it('says no kernel OOM kill when neither counter moved (a userspace killer or kill -9)', () => {
    expect(
      linuxOomKillDetails({ vmstatOomKill: 7, cgroupOomKill: 2 }, 5_000, {
        vmstatOomKill: 7,
        cgroupOomKill: 2
      })
    ).toMatchObject({ linuxOomKillVerdict: 'no-kernel-oom-kill' })
  })

  it('emits nothing when no counter was readable on both sides', () => {
    expect(linuxOomKillDetails({}, 5_000, { vmstatOomKill: 1 })).toEqual({})
  })
})

describe('preGoneLinuxOomKillDetails', () => {
  beforeEach(() => {
    resetPreGoneSystemMemorySamplingForTest()
    setSystemMemoryInfoReaderForTest(() => ({
      total: 16_000 * 1024,
      available: 4_000 * 1024
    }))
    setSwapVolumeFreeSpaceReaderForTest(vi.fn(async () => undefined))
  })

  afterEach(() => {
    resetPreGoneSystemMemorySamplingForTest()
    setSystemMemoryInfoReaderForTest(null)
    setSwapVolumeFreeSpaceReaderForTest(null)
  })

  it('is empty before any baseline was sampled', () => {
    setLinuxOomKillFileReaderForTest(fakeHost({ hostKills: 0, cgroupKills: 0 }), 'linux')
    expect(preGoneLinuxOomKillDetails(1_000)).toEqual({})
  })

  it('compares against the older baseline so a tick between kill and gone event cannot hide it', async () => {
    const state = { hostKills: 0, cgroupKills: 0 }
    setLinuxOomKillFileReaderForTest(fakeHost(state), 'linux')
    await samplePreGoneSystemMemory(10_000)
    state.hostKills = 1
    state.cgroupKills = 1
    // The next tick lands after the kernel killed the renderer but before main saw it go.
    await samplePreGoneSystemMemory(20_000)
    expect(preGoneLinuxOomKillDetails(20_050)).toMatchObject({
      linuxOomKillBaselineAgeMs: 10_050,
      linuxOomKillCgroupDelta: 1,
      linuxOomKillVerdict: 'orca-cgroup-oom-kill'
    })
  })

  it('reads the baseline daemon scope by path after the OOM-killed daemon pid is gone', async () => {
    const state = {
      hostKills: 0,
      cgroupKills: 0,
      daemonCgroup: DAEMON_SCOPE,
      daemonKills: 0
    }
    setLinuxOomKillFileReaderForTest(fakeHost(state), 'linux')
    setLinuxOomKillDaemonPidSource(() => DAEMON_PID)
    await samplePreGoneSystemMemory(10_000)
    state.hostKills = 1
    state.daemonKills = 1
    state.daemonCgroup = ''
    expect(preGoneLinuxOomKillDetails(10_050)).toMatchObject({
      linuxOomKillDaemonCgroupDelta: 1,
      linuxOomKillVerdict: 'daemon-cgroup-oom-kill'
    })
  })

  it('leaves a host kill unattributed when the baseline daemon scope is no longer readable', async () => {
    const state = { hostKills: 0, cgroupKills: 0, daemonCgroup: DAEMON_SCOPE }
    let daemonScopeRemoved = false
    const host = fakeHost(state)
    setLinuxOomKillFileReaderForTest(
      (path) =>
        daemonScopeRemoved && path === `/sys/fs/cgroup${DAEMON_SCOPE}/memory.events`
          ? undefined
          : host(path),
      'linux'
    )
    setLinuxOomKillDaemonPidSource(() => DAEMON_PID)
    await samplePreGoneSystemMemory(10_000)
    state.hostKills = 1
    daemonScopeRemoved = true
    const details = preGoneLinuxOomKillDetails(10_050)
    expect(details).not.toHaveProperty('linuxOomKillDaemonCgroupDelta')
    expect(details).toMatchObject({
      linuxOomKillVerdict: 'host-oom-kill-unattributed'
    })
  })

  it('is empty off Linux', async () => {
    setLinuxOomKillFileReaderForTest(fakeHost({ hostKills: 0, cgroupKills: 0 }), 'win32')
    await samplePreGoneSystemMemory(10_000)
    expect(preGoneLinuxOomKillDetails(10_050)).toEqual({})
  })
})
