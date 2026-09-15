import { afterEach, describe, expect, it } from 'vitest'
import { collectServeStatsHost, resolveCgroupV2Directories } from './serve-stats-host'
import {
  disableServeStatsEventLoopDelayMonitorForTest,
  enableServeStatsEventLoopDelayMonitor,
  readServeStatsEventLoopDelayP99Ms
} from './serve-stats-event-loop-delay'
import { setTimeout } from 'node:timers/promises'

const KIB = 1024
const GIB = 1024 ** 3

const LINUX_MEMINFO = [
  'MemTotal:       16777216 kB',
  'MemFree:          262144 kB',
  'MemAvailable:    4194304 kB',
  'SwapTotal:       8388608 kB',
  'SwapFree:        5888608 kB',
  ''
].join('\n')

// Measured on the host this was written against: a systemd unit's own cgroup, whose pids.max is
// the unit's TasksMax. The root cgroup has no pids.* files at all, which is why the reader
// resolves /proc/self/cgroup instead of reading a fixed path (#18789's 4096 was a unit limit).
const SELF_CGROUP = '0::/system.slice/system-orca\\x2dserve.slice/orca-serve@factory.service\n'
const UNIT_CGROUP =
  '/sys/fs/cgroup/system.slice/system-orca\\x2dserve.slice/orca-serve@factory.service'
const LINUX_CGROUP_PIDS: Record<string, string> = {
  [`${UNIT_CGROUP}/pids.current`]: '5279\n',
  [`${UNIT_CGROUP}/pids.max`]: '16384\n'
}

function sources(overrides: Parameters<typeof collectServeStatsHost>[0] = {}) {
  return {
    platform: 'linux' as NodeJS.Platform,
    loadAverage: () => [6.85, 4.2, 3.1],
    cpuCoreCount: () => 4,
    totalMemoryBytes: () => 16 * GIB,
    freeMemoryBytes: () => 256 * 1024 * KIB,
    readMeminfo: () => LINUX_MEMINFO,
    readSelfCgroup: () => SELF_CGROUP,
    readCgroupFile: (filePath: string) => LINUX_CGROUP_PIDS[filePath] ?? null,
    ...overrides
  }
}

describe('collectServeStatsHost', () => {
  it('prefers Linux MemAvailable over freemem and reports swap in use', () => {
    const host = collectServeStatsHost(sources())

    expect(host).toEqual({
      loadAverage1m: 6.85,
      cpuCoreCount: 4,
      memoryTotalBytes: 16 * GIB,
      // MemAvailable (4 GiB), not MemFree (256 MiB): freemem excludes reclaimable page cache and
      // so understates what the host can actually hand out.
      memoryAvailableBytes: 4 * GIB,
      memoryAvailableSource: 'proc-meminfo',
      // #14552's "Swap in use 2.5 GB" — SwapTotal minus SwapFree.
      swapUsedBytes: 2_500_000 * KIB,
      // The unit's own ceiling, read as a pair: current alone cannot say how close to it the host
      // is (#18789).
      pids: { current: 5279, max: 16384 }
    })
  })

  it('reports null, never zero, for everything a Windows host cannot measure', () => {
    // Node returns [0, 0, 0] from os.loadavg() on Windows, and a 0 here would read as an idle host
    // while the machine is saturated (#19312).
    const host = collectServeStatsHost(
      sources({
        platform: 'win32',
        loadAverage: () => [0, 0, 0],
        readMeminfo: () => {
          throw new Error('no procfs on win32')
        }
      })
    )

    expect(host.loadAverage1m).toBeNull()
    expect(host.swapUsedBytes).toBeNull()
    // No cgroup pid controller off Linux; 0 here would claim an empty cgroup.
    expect(host.pids).toBeNull()
    // Still measurable through node:os, so these stay numbers.
    expect(host.cpuCoreCount).toBe(4)
    expect(host.memoryTotalBytes).toBe(16 * GIB)
    expect(host.memoryAvailableBytes).toBe(256 * 1024 * KIB)
    expect(host.memoryAvailableSource).toBe('free-memory')
  })

  it('falls back to freemem and null swap when procfs is unreadable', () => {
    const host = collectServeStatsHost(sources({ readMeminfo: () => null }))

    expect(host.memoryAvailableSource).toBe('free-memory')
    expect(host.memoryAvailableBytes).toBe(256 * 1024 * KIB)
    expect(host.swapUsedBytes).toBeNull()
    // A missing metric must never fail the command.
    expect(host.loadAverage1m).toBe(6.85)
  })

  it('separates swap disabled (a measured zero) from swap unreadable (null)', () => {
    const swapless = collectServeStatsHost(
      sources({ readMeminfo: () => 'MemAvailable: 4194304 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' })
    )
    const unreported = collectServeStatsHost(
      sources({ readMeminfo: () => 'MemAvailable: 4194304 kB\n' })
    )

    expect(swapless.swapUsedBytes).toBe(0)
    expect(unreported.swapUsedBytes).toBeNull()
    // The memory reading still lands even when the swap lines are absent.
    expect(unreported.memoryAvailableSource).toBe('proc-meminfo')
  })

  it('maps an unlimited cgroup pid ceiling to null rather than inventing a number', () => {
    const host = collectServeStatsHost(
      sources({
        readCgroupFile: (filePath: string) =>
          filePath.endsWith('pids.max') ? 'max\n' : (LINUX_CGROUP_PIDS[filePath] ?? null)
      })
    )

    // The literal `max` means no limit. 0 would read as "no pids allowed" and Infinity is not
    // JSON, so the ceiling is null while `current` stays a real measurement.
    expect(host.pids).toEqual({ current: 5279, max: null })
  })

  it('reads the nearest enclosing cgroup when the leaf has no pid controller', () => {
    // The root cgroup never carries controller files, and a delegated leaf may not either — the
    // limit that binds is then the closest ancestor that does. Reading only /sys/fs/cgroup
    // reported null on the systemd host this was measured on.
    const sliceCgroup = '/sys/fs/cgroup/system.slice/system-orca\\x2dserve.slice'
    const host = collectServeStatsHost(
      sources({
        readCgroupFile: (filePath: string) =>
          ({
            [`${sliceCgroup}/pids.current`]: '5279\n',
            [`${sliceCgroup}/pids.max`]: '16384\n'
          })[filePath] ?? null
      })
    )

    expect(host.pids).toEqual({ current: 5279, max: 16384 })
  })

  it('reports null pids where there is no cgroup v2 pid controller to read', () => {
    const unmounted = collectServeStatsHost(sources({ readCgroupFile: () => null }))
    // cgroup v1 has no `0::` line at all, so there is no directory to even try.
    const cgroupV1 = collectServeStatsHost(
      sources({ readSelfCgroup: () => '3:pids:/user.slice\n1:name=systemd:/user.slice\n' })
    )
    // A half-read must drop the whole pair rather than report current against an unknown ceiling.
    const currentOnly = collectServeStatsHost(
      sources({
        readCgroupFile: (filePath: string) =>
          filePath.endsWith('pids.current') ? (LINUX_CGROUP_PIDS[filePath] ?? null) : null
      })
    )
    const noProcfs = collectServeStatsHost(sources({ readSelfCgroup: () => null }))

    expect(unmounted.pids).toBeNull()
    expect(cgroupV1.pids).toBeNull()
    expect(currentOnly.pids).toBeNull()
    expect(noProcfs.pids).toBeNull()
  })

  it('never reads a blank or unparseable pids file as zero', () => {
    const blank = collectServeStatsHost(sources({ readCgroupFile: () => '\n' }))
    const garbage = collectServeStatsHost(sources({ readCgroupFile: () => 'unexpected' }))

    // `Number('')` is 0: a 0 current would claim a cgroup with nothing running, and a 0 max a
    // cgroup that forbids every pid.
    expect(blank.pids).toBeNull()
    expect(garbage.pids).toBeNull()
  })

  it('walks the process cgroup nearest-first, ending at the mount root', () => {
    // Nearest first: the tightest scope with the controller enabled is the ceiling a clone() hits.
    expect(resolveCgroupV2Directories(SELF_CGROUP)).toEqual([
      UNIT_CGROUP,
      '/sys/fs/cgroup/system.slice/system-orca\\x2dserve.slice',
      '/sys/fs/cgroup/system.slice',
      '/sys/fs/cgroup'
    ])
    // A container whose own cgroup IS the mount root: the fixed path everyone expects, and the
    // only case where it works.
    expect(resolveCgroupV2Directories('0::/\n')).toEqual(['/sys/fs/cgroup'])
    expect(resolveCgroupV2Directories('11:pids:/docker/abc\n')).toEqual([])
  })

  it('keeps available memory inside physical RAM and never below freemem', () => {
    const host = collectServeStatsHost(
      sources({
        totalMemoryBytes: () => 2 * GIB,
        freeMemoryBytes: () => GIB,
        readMeminfo: () => `MemAvailable: ${99 * 1024 * 1024} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`
      })
    )

    expect(host.memoryAvailableBytes).toBe(2 * GIB)
  })
})

describe('serve stats event loop delay monitor', () => {
  afterEach(() => {
    disableServeStatsEventLoopDelayMonitorForTest()
  })

  it('reads null until the monitor is enabled and has a sample', () => {
    disableServeStatsEventLoopDelayMonitorForTest()

    expect(readServeStatsEventLoopDelayP99Ms()).toBeNull()

    enableServeStatsEventLoopDelayMonitor()

    // Enabled but nothing sampled yet is still unmeasured, never a healthy-looking 0.
    expect(readServeStatsEventLoopDelayP99Ms()).toBeNull()
  })

  it('reports a number once sampled and resets the window on read', async () => {
    disableServeStatsEventLoopDelayMonitorForTest()
    enableServeStatsEventLoopDelayMonitor()
    // Real elapsed time, deliberately: libuv samples this histogram itself, so a virtual clock
    // advances no ticks and produces no samples at all. Polls the awaited condition (a recorded
    // sample) instead of guessing one fixed sleep, so it costs one 20ms tick in the normal case.
    const first = await pollForEventLoopDelaySample()

    expect(typeof first).toBe('number')
    expect(first).toBeGreaterThanOrEqual(0)
    // Reset-on-read: the window just consumed is gone, so the next read has no sample of its own
    // rather than re-reporting a stale percentile for the rest of the runtime's life (#19312).
    expect(readServeStatsEventLoopDelayP99Ms()).toBeNull()
  })
})

async function pollForEventLoopDelaySample(): Promise<number | null> {
  for (let attempt = 0; attempt < 50; attempt++) {
    await setTimeout(25)
    const reading = readServeStatsEventLoopDelayP99Ms()
    if (reading !== null) {
      return reading
    }
  }
  return null
}
