import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { decodeHostResourcesSnapshot } from '../../shared/host-resources'
import type { CpuTimeSample, HostVolumeMeasurement } from './host-resources'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))

const KIB = 1024
const MIB = 1024 ** 2
const GIB = 1024 ** 3

function cpuTimes(user: number, idle: number, nice = 0, sys = 0, irq = 0): CpuTimeSample {
  return { user, nice, sys, idle, irq }
}

function cpuInfo(times: CpuTimeSample, model = 'Test CPU'): os.CpuInfo {
  return { model, speed: 2400, times }
}

async function loadHostResources() {
  vi.resetModules()
  return import('./host-resources')
}

describe('host resource parsers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    runProcessMock.mockReset()
  })

  it('parses Linux swap and treats a zero SwapTotal as absent', async () => {
    const { parseLinuxSwap } = await loadHostResources()

    expect(parseLinuxSwap('MemTotal: 4096 kB\nSwapTotal: 2048 kB\nSwapFree: 512 kB\n')).toEqual({
      totalBytes: 2048 * KIB,
      usedBytes: 1536 * KIB,
      usedPercent: 75
    })
    expect(parseLinuxSwap('SwapTotal: 0 kB\nSwapFree: 0 kB\n')).toBeNull()
    expect(parseLinuxSwap('SwapFree: 10 kB\n')).toBeNull()
  })

  it('parses Darwin swap usage in M and G and rejects garbage', async () => {
    const { parseDarwinSwapUsage } = await loadHostResources()

    expect(
      parseDarwinSwapUsage(
        'vm.swapusage: total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)'
      )
    ).toEqual({
      totalBytes: 2048 * MIB,
      usedBytes: Math.round(1024.5 * MIB),
      usedPercent: 50
    })
    expect(parseDarwinSwapUsage('total = 1.50G used = 0.75G free = 0.75G')).toEqual({
      totalBytes: Math.round(1.5 * GIB),
      usedBytes: Math.round(0.75 * GIB),
      usedPercent: 50
    })
    expect(parseDarwinSwapUsage('not swap')).toBeNull()
    expect(parseDarwinSwapUsage('total = 0.00M used = 0.00M free = 0.00M')).toBeNull()
  })

  it('turns cpu time deltas into an overall percent and one percent per core', async () => {
    const { cpuPercentsFromDelta } = await loadHostResources()
    const previous = [cpuTimes(0, 0), cpuTimes(0, 0)]
    const idleHeavy = [cpuTimes(1, 99), cpuTimes(4, 96)]
    const busy = [cpuTimes(40, 10, 20, 20, 10), cpuTimes(80, 20)]

    const idle = cpuPercentsFromDelta(previous, idleHeavy)
    const hot = cpuPercentsFromDelta(previous, busy)
    const zero = cpuPercentsFromDelta(previous, previous)

    expect(idle.percent).toBe(2.5)
    expect(idle.cores).toEqual([{ percent: 1 }, { percent: 4 }])
    expect(hot.percent).toBe(85)
    expect(hot.cores).toEqual([{ percent: 90 }, { percent: 80 }])
    expect(zero.percent).toBeNull()
    expect(zero.cores).toEqual([{ percent: null }, { percent: null }])
    expect(idle.cores).toHaveLength(idleHeavy.length)
    expect(hot.cores).toHaveLength(busy.length)
    expect(zero.cores).toHaveLength(previous.length)
  })

  it('merges volumes on one device and keeps a second device in input order', async () => {
    const { dedupeHostVolumes } = await loadHostResources()
    const rows = dedupeHostVolumes([
      measurement('home', 1, '/', 40, 60, 100),
      measurement('workspace', 1, '/', 99, 1, 100),
      measurement('workspace', 2, '/Volumes/code', 10, 30, 40)
    ])

    expect(rows).toEqual([
      {
        role: 'home-and-workspace',
        usedBytes: 40,
        freeBytes: 60,
        totalBytes: 100,
        usedPercent: 40
      },
      { role: 'workspace', usedBytes: 10, freeBytes: 30, totalBytes: 40, usedPercent: 25 }
    ])
    expect(JSON.stringify(rows)).not.toContain('/Volumes/code')
    expect(rows.every((row) => !('path' in row) && !('dev' in row) && !('root' in row))).toBe(true)
  })

  it('groups dev 0 volumes by filesystem root instead of collapsing them', async () => {
    const { dedupeHostVolumes } = await loadHostResources()

    expect(
      dedupeHostVolumes([
        measurement('workspace', 0, 'D:\\', 1, 1, 2),
        measurement('home', 0, 'C:\\', 3, 1, 4),
        measurement('workspace', 0, 'C:\\', 9, 1, 4)
      ])
    ).toEqual([
      {
        role: 'home-and-workspace',
        usedBytes: 3,
        freeBytes: 1,
        totalBytes: 4,
        usedPercent: 75
      },
      { role: 'workspace', usedBytes: 1, freeBytes: 1, totalBytes: 2, usedPercent: 50 }
    ])
  })
})

describe('collectHostResources', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    runProcessMock.mockReset()
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(os, 'totalmem').mockReturnValue(1_000)
    vi.spyOn(os, 'freemem').mockReturnValue(400)
    vi.spyOn(os, 'loadavg').mockReturnValue([3, 2, 1])
    vi.spyOn(os, 'uptime').mockReturnValue(50)
    vi.spyOn(os, 'cpus').mockReturnValue([cpuInfo(cpuTimes(1, 9))])
  })

  it('does not spawn on Windows and omits swap and load average', async () => {
    const { collectHostResources } = await loadHostResources()

    const snapshot = await collectHostResources([], { wait: async () => {} })

    expect(runProcessMock).not.toHaveBeenCalled()
    expect(snapshot.memory.swap).toBeNull()
    expect(snapshot.cpu.loadAverage1m).toBeNull()
    expect(snapshot.memory).toMatchObject({ usedBytes: 600, totalBytes: 1_000, usedPercent: 60 })
    expect(decodeHostResourcesSnapshot(snapshot)).toEqual(snapshot)
  })

  it('reads Darwin swap with sysctl and still uses collectHostMemory', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    vi.spyOn(os, 'loadavg').mockReturnValue([1.5, 1, 0.5])
    vi.spyOn(os, 'freemem').mockReturnValue(100)
    runProcessMock.mockImplementation(async (spec: { program: string }) => {
      if (spec.program === '/usr/sbin/sysctl') {
        return {
          code: 0,
          signal: null,
          stdout: 'vm.swapusage: total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)',
          stderr: '',
          timedOut: false
        }
      }
      if (spec.program === '/usr/bin/memory_pressure') {
        return {
          code: 0,
          signal: null,
          stdout: 'System-wide memory free percentage: 79%',
          stderr: '',
          timedOut: false
        }
      }
      throw new Error(`unexpected program ${spec.program}`)
    })
    const { collectHostResources } = await loadHostResources()

    const snapshot = await collectHostResources([], { wait: async () => {} })

    expect(runProcessMock).toHaveBeenCalledWith({
      program: '/usr/sbin/sysctl',
      args: ['vm.swapusage'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      maxOutputBytes: 65_536,
      timeoutMs: 1_000
    })
    expect(runProcessMock).toHaveBeenCalledWith({
      program: '/usr/bin/memory_pressure',
      args: ['-Q'],
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      maxOutputBytes: 64 * 1024,
      timeoutMs: 1_000
    })
    expect(snapshot.memory).toEqual({
      usedBytes: 210,
      totalBytes: 1_000,
      usedPercent: 21,
      swap: { usedBytes: 1024 * MIB, totalBytes: 2048 * MIB, usedPercent: 50 }
    })
    expect(snapshot.cpu.loadAverage1m).toBe(1.5)
    expect(decodeHostResourcesSnapshot(snapshot)).toEqual(snapshot)
    const broken: Record<string, unknown> = { ...snapshot }
    delete broken.cpu
    expect(decodeHostResourcesSnapshot(broken)).toBeNull()
  })

  it('samples cpu twice until a baseline exists and again after 10s', async () => {
    let now = 10_000
    const waits: number[] = []
    const samples = [
      [cpuTimes(0, 0)],
      [cpuTimes(10, 90)],
      [cpuTimes(20, 180)],
      [cpuTimes(20, 180)],
      [cpuTimes(50, 250)]
    ]
    let cursor = 0
    const { collectHostResources } = await loadHostResources()
    const readers = {
      now: () => now,
      wait: async (ms: number) => {
        waits.push(ms)
        now += ms
      },
      readCpus: () => {
        const times = samples[Math.min(cursor, samples.length - 1)] ?? []
        cursor += 1
        return times.map((sample) => cpuInfo(sample, 'Xeon'))
      },
      uptime: () => 42
    }

    const first = await collectHostResources([], readers)
    expect(waits).toEqual([200])
    expect(first.cpu).toMatchObject({
      percent: 10,
      coreCount: 1,
      model: 'Xeon',
      cores: [{ percent: 10 }]
    })
    expect(first.uptimeSeconds).toBe(42)
    expect(first.sampledAt).toBe(now)

    now += 1_000
    const second = await collectHostResources([], readers)
    expect(waits).toEqual([200])
    expect(second.cpu.percent).toBe(10)

    now += 10_001
    const third = await collectHostResources([], readers)
    expect(waits).toEqual([200, 200])
    expect(third.cpu.percent).toBe(30)
  })

  it('dedupes statfs volumes without keeping paths', async () => {
    const root = path.parse(process.cwd()).root
    const home = path.join(root, 'home-a')
    const alsoHome = path.join(root, 'home-b')
    const { collectHostResources } = await loadHostResources()

    const snapshot = await collectHostResources(
      [
        { role: 'home', path: home },
        { role: 'workspace', path: alsoHome },
        { role: 'workspace', path: 'relative-work' },
        { role: 'workspace', path: '/missing' },
        { role: 'workspace', path: '/huge' }
      ],
      {
        wait: async () => {},
        stat: async (file) => {
          if (file === '/missing') {
            throw new Error('enoent')
          }
          return { dev: file === '/huge' ? 9 : 0 }
        },
        statfs: async (file) => {
          if (file === '/huge') {
            return {
              blocks: Number.MAX_SAFE_INTEGER,
              bsize: 8,
              bavail: 1,
              bfree: 1
            }
          }
          if (file === 'relative-work') {
            return { blocks: 4, bsize: 10, bavail: 1, bfree: 2 }
          }
          return { blocks: 20, bsize: 10, bavail: 5, bfree: 8 }
        }
      }
    )

    expect(snapshot.volumes).toEqual([
      {
        role: 'home-and-workspace',
        usedBytes: 120,
        freeBytes: 50,
        totalBytes: 200,
        usedPercent: 60
      },
      { role: 'workspace', usedBytes: 20, freeBytes: 10, totalBytes: 40, usedPercent: 50 }
    ])
    const encoded = JSON.stringify(snapshot.volumes)
    expect(encoded).not.toContain(home)
    expect(encoded).not.toContain('relative-work')
    expect(encoded).not.toContain('/missing')
    expect(encoded).not.toContain('/huge')
  })
})

function measurement(
  role: HostVolumeMeasurement['role'],
  dev: number,
  root: string,
  usedBytes: number,
  freeBytes: number,
  totalBytes: number
): HostVolumeMeasurement {
  return { role, dev, root, usedBytes, freeBytes, totalBytes }
}
