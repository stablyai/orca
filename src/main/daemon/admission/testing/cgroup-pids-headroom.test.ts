import { describe, expect, it, vi } from 'vitest'
import {
  cgroupPidsDirectories,
  createCgroupPidsReader,
  cgroupPidsPressure,
  fullestPidsUsage,
  type CgroupPidsUsage
} from '../cgroup-pids-headroom'
import { DaemonProcessGrowthMonitor } from '../daemon-process-growth-monitor'
import { TerminalSpawnGate } from '../terminal-spawn-gate'

// #40327: a container's cgroup pids.max counts threads, which process-growth sampling cannot see,
// so a fast spawn wave could exhaust it before the breaker reacted.
describe('cgroup task-limit paths and pressure', () => {
  const V2_MOUNT = '30 25 0:26 / /sys/fs/cgroup rw,nosuid shared:4 - cgroup2 cgroup2 rw\n'

  it('checks the process cgroup and every ancestor', () => {
    expect(cgroupPidsDirectories('0::/system.slice/orca.service\n', V2_MOUNT)).toEqual([
      '/sys/fs/cgroup/system.slice/orca.service',
      '/sys/fs/cgroup/system.slice',
      '/sys/fs/cgroup'
    ])
  })

  it('prefers the v1 pids controller on a hybrid host, wherever it is mounted', () => {
    const mountinfo = `${V2_MOUNT}35 25 0:30 / /sys/fs/cgroup/cpu,pids rw,nosuid shared:9 - cgroup cgroup rw,cpu,pids\n`
    expect(
      cgroupPidsDirectories(
        '4:cpu,pids:/docker/abc\n3:memory:/docker/abc\n0::/init.scope\n',
        mountinfo
      )
    ).toEqual([
      '/sys/fs/cgroup/cpu,pids/docker/abc',
      '/sys/fs/cgroup/cpu,pids/docker',
      '/sys/fs/cgroup/cpu,pids'
    ])
  })

  it('reads a container whose mount root is its own cgroup', () => {
    const mountinfo = '40 30 0:26 /docker/abc /sys/fs/cgroup ro - cgroup2 cgroup2 rw\n'
    expect(cgroupPidsDirectories('0::/docker/abc/sub\n', mountinfo)).toEqual([
      '/sys/fs/cgroup/sub',
      '/sys/fs/cgroup'
    ])
  })

  it('keeps colons in a path and ignores paths outside the namespace or mount root', () => {
    expect(cgroupPidsDirectories('0::/a:b\n', V2_MOUNT)).toEqual([
      '/sys/fs/cgroup/a:b',
      '/sys/fs/cgroup'
    ])
    expect(cgroupPidsDirectories('0::/../../user.slice\n', V2_MOUNT)).toEqual([])
    expect(
      cgroupPidsDirectories('0::/x\n', '40 30 0:26 /docker /sys/fs/cgroup ro - cgroup2 c rw\n')
    ).toEqual([])
    expect(cgroupPidsDirectories('0::/x\n', '')).toEqual([])
  })

  it('reads the cgroup of a process whose cgroup was removed', () => {
    expect(cgroupPidsDirectories('0::/system.slice/old.scope (deleted)\n', V2_MOUNT)).toEqual([
      '/sys/fs/cgroup/system.slice/old.scope',
      '/sys/fs/cgroup/system.slice',
      '/sys/fs/cgroup'
    ])
  })

  it('uses the mount that shows the most ancestors of the path', () => {
    const mountinfo = [
      '40 30 0:26 /other /mnt/other ro - cgroup2 cgroup2 rw',
      '41 30 0:26 / /sys/fs/cgroup ro - cgroup2 cgroup2 rw',
      '42 30 0:26 /docker/abc /run/abc ro - cgroup2 cgroup2 rw',
      ''
    ].join('\n')
    expect(cgroupPidsDirectories('0::/docker/abc/sub\n', mountinfo)).toEqual([
      '/sys/fs/cgroup/docker/abc/sub',
      '/sys/fs/cgroup/docker/abc',
      '/sys/fs/cgroup/docker',
      '/sys/fs/cgroup'
    ])
  })

  it('finds the cap directories once and reports why protection is off', async () => {
    const resolve = vi.fn(async () => ({
      directories: [],
      problem: 'mountinfo-too-large' as const
    }))
    const onResolved = vi.fn()
    const read = createCgroupPidsReader(onResolved, resolve, async () => '0::/a\n')

    await expect(read()).resolves.toBeNull()
    await expect(read()).resolves.toBeNull()

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(onResolved).toHaveBeenCalledTimes(1)
    expect(onResolved).toHaveBeenCalledWith({ directories: [], problem: 'mountinfo-too-large' })
  })

  it('finds the cap directories again after the daemon moves to another cgroup', async () => {
    let membership = '0::/app-orca-old.scope\n'
    const resolve = vi.fn(async () => ({ directories: [] }))
    const read = createCgroupPidsReader(
      () => {},
      resolve,
      async () => membership
    )
    await read()
    await read()
    expect(resolve).toHaveBeenCalledTimes(1)

    membership = '0::/app-orca-new.scope\n'
    await read()
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenLastCalledWith('0::/app-orca-new.scope\n')
  })

  it('reports the fullest cap and ignores unlimited ones', () => {
    expect(
      fullestPidsUsage([
        { cgroup: 'leaf', current: '40\n', max: 'max\n' },
        { cgroup: 'small', current: '85\n', max: '100\n' },
        { cgroup: 'large', current: '9000\n', max: '10000\n' }
      ])
    ).toEqual({ cgroup: 'large', current: 9000, max: 10000 })
    expect(fullestPidsUsage([{ cgroup: 'root', current: '10', max: 'max' }])).toBeNull()
  })

  it('turns critical at 90% and clears only below 85%', () => {
    const at = (current: number): CgroupPidsUsage => ({ cgroup: 'c', current, max: 1000 })
    expect(cgroupPidsPressure(at(899))).toBe('ok')
    expect(cgroupPidsPressure(at(900))).toBe('critical')
    expect(cgroupPidsPressure(at(860), 'critical')).toBe('critical')
    expect(cgroupPidsPressure(at(849), 'critical')).toBe('ok')
    expect(cgroupPidsPressure(null)).toBe('ok')
  })
})

describe('the growth monitor with a cgroup task limit', () => {
  function monitorWith(readPids: () => Promise<CgroupPidsUsage | null>) {
    let now = 0
    const monitor = new DaemonProcessGrowthMonitor({
      listSessions: () => [{ sessionId: 'session-1', pid: 100 }],
      recentAutomaticWork: () => false,
      sampleWhenIdle: false,
      onLevelChanged: () => {},
      onTrip: () => {},
      readRows: async () => [],
      readPids,
      rootPid: 1,
      now: () => now
    })
    return { monitor, advance: (ms: number) => (now += ms) }
  }

  it('names the task limit, not process growth, as the cause of its critical level', async () => {
    const onLevelChanged = vi.fn()
    const monitor = new DaemonProcessGrowthMonitor({
      listSessions: () => [],
      recentAutomaticWork: () => false,
      sampleWhenIdle: false,
      onLevelChanged,
      onTrip: () => {},
      readRows: async () => [],
      readPids: async () => ({ cgroup: 'c', current: 95, max: 100 })
    })
    await monitor.sample()
    expect(onLevelChanged).toHaveBeenCalledWith('critical', 'cgroup-pids')
  })

  it('is critical from its startup reading, before any sample', async () => {
    const { monitor } = monitorWith(async () => ({ cgroup: 'c', current: 95, max: 100 }))
    monitor.start()
    await vi.waitFor(() => expect(monitor.level).toBe('critical'))
    monitor.stop()
  })

  it('picks up a filling cap through admission, between samples', async () => {
    let usage = { cgroup: 'c', current: 10, max: 100 }
    const { monitor, advance } = monitorWith(async () => usage)
    await monitor.sample()
    expect(monitor.level).not.toBe('critical')

    usage = { cgroup: 'c', current: 95, max: 100 }
    advance(1_000)
    monitor.admissionLevel()
    await vi.waitFor(() => expect(monitor.level).toBe('critical'))
  })

  it('treats a cap of zero as full', () => {
    expect(fullestPidsUsage([{ cgroup: 'zero', current: '0', max: '0' }])).toEqual({
      cgroup: 'zero',
      current: 0,
      max: 0
    })
    expect(cgroupPidsPressure({ cgroup: 'zero', current: 0, max: 0 })).toBe('critical')
  })

  it('still reports a growth trip that follows a near-limit reading', async () => {
    const rows: { pid: number; ppid: number }[] = [{ pid: 100, ppid: 1 }]
    const usage = { cgroup: 'c', current: 95, max: 100 }
    let now = 0
    const onTrip = vi.fn()
    const monitor = new DaemonProcessGrowthMonitor({
      listSessions: () => [{ sessionId: 'session-1', pid: 100 }],
      recentAutomaticWork: () => false,
      sampleWhenIdle: false,
      onLevelChanged: () => {},
      onTrip,
      readRows: async () => rows,
      readPids: async () => usage,
      rootPid: 1,
      now: () => now
    })
    await monitor.sample()
    expect(monitor.level).toBe('critical')

    for (let step = 1; step <= 12 && onTrip.mock.calls.length === 0; step += 1) {
      now += 5_000
      for (let child = 0; child < 200; child += 1) {
        rows.push({ pid: 1_000 + step * 1_000 + child, ppid: 100 })
      }
      await monitor.sample()
    }
    // The cap stays nearly full throughout, yet the growth breaker still evaluates and trips.
    expect(onTrip).toHaveBeenCalled()
    expect(monitor.level).toBe('critical')
  })
})

describe('admission before the first task-limit reading', () => {
  it('waits for it, so a host that starts nearly full does not admit its restore wave', async () => {
    let finishReading = (): void => {}
    const reading = new Promise<void>((resolve) => {
      finishReading = resolve
    })
    let pending = true
    const gate = new TerminalSpawnGate({
      log: () => {},
      mode: 'enforce',
      pressure: () => (pending ? 'unknown' : 'critical'),
      pressureReading: () => (pending ? reading : null)
    })
    const facts = {
      clientId: 'client-1',
      declaredIntent: 'automatic-restore' as const,
      hasAgentSessionClaim: true,
      hasHistorySeed: false,
      deadlineAt: Date.now() + 60_000
    }

    const admitted = gate.admit(facts)
    expect(admitted).toBeInstanceOf(Promise)
    pending = false
    finishReading()

    await expect(admitted).rejects.toThrow()
  })
})

describe('a first task-limit read that never finishes', () => {
  it('stops holding admission and sampling after 2 s and says so', async () => {
    vi.useFakeTimers()
    try {
      const onPidsReadStalled = vi.fn()
      const monitor = new DaemonProcessGrowthMonitor({
        listSessions: () => [],
        recentAutomaticWork: () => false,
        sampleWhenIdle: false,
        onLevelChanged: () => {},
        onTrip: () => {},
        onPidsReadStalled,
        readRows: async () => [],
        readPids: () => new Promise(() => {})
      })
      const waiting = monitor.initialReading()
      expect(waiting).not.toBeNull()

      await vi.advanceTimersByTimeAsync(2_000)
      await waiting

      expect(onPidsReadStalled).toHaveBeenCalledWith(2_000)
      expect(monitor.initialReading()).toBeNull()

      // The sampling loop is not held either: a sample settles while the read stays stalled.
      await vi.advanceTimersByTimeAsync(1_000)
      const sampled = monitor.sample()
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(sampled).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('task-limit reads that hang', () => {
  it('are abandoned, never stacked, retried once they settle, and never stop sampling', async () => {
    vi.useFakeTimers()
    try {
      const pending: ((usage: CgroupPidsUsage | null) => void)[] = []
      const readPids = vi.fn(
        () => new Promise<CgroupPidsUsage | null>((resolve) => pending.push(resolve))
      )
      const readRows = vi.fn(async () => [{ pid: 100, ppid: 1 }])
      const onPidsReadStalled = vi.fn()
      const monitor = new DaemonProcessGrowthMonitor({
        listSessions: () => [{ sessionId: 'session-1', pid: 100 }],
        recentAutomaticWork: () => false,
        sampleWhenIdle: true,
        onLevelChanged: () => {},
        onTrip: () => {},
        onPidsReadStalled,
        readRows,
        readPids,
        rootPid: 1
      })
      monitor.start()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(onPidsReadStalled).toHaveBeenCalledTimes(1)

      // While the stalled read is still pending, nothing starts another one or logs again.
      await vi.advanceTimersByTimeAsync(1_000)
      monitor.admissionLevel()
      // Idle samples run every 30 s and keep sampling growth.
      await vi.advanceTimersByTimeAsync(3 * 30_000)
      expect(readPids).toHaveBeenCalledTimes(1)
      expect(onPidsReadStalled).toHaveBeenCalledTimes(1)
      expect(readRows.mock.calls.length).toBeGreaterThanOrEqual(2)

      // Once it settles, the next refresh reads again.
      pending[0]?.(null)
      await vi.advanceTimersByTimeAsync(0)
      monitor.admissionLevel()
      expect(readPids).toHaveBeenCalledTimes(2)
      monitor.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
