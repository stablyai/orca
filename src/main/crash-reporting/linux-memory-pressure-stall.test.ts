import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MEMORY_STALL_HIGH_AVG10_PERCENT,
  parseMemoryPressureStall,
  readLinuxMemoryPressureStall,
  setLinuxMemoryPressureStallReaderForTest
} from './linux-memory-pressure-stall'
import {
  setLinuxCgroupMemoryLimitReaderForTest,
  setLinuxPseudoFileReaderForTest
} from './linux-cgroup-memory-limit'
import { getSystemMemoryDetails, setSystemMemoryInfoReaderForTest } from './system-memory-details'
import {
  preGoneSystemMemoryDetails,
  resetPreGoneSystemMemorySamplingForTest,
  samplePreGoneSystemMemory
} from './pre-gone-host-memory'

// Field report 181e8e36: renderer reason=killed exitCode=9 with 9668 MB
// available and swap all but untouched. (A GPU exit 9 sits 9m 04.9s earlier in
// the same session — a separate kill, not a co-timed whole-cgroup one.) Only the
// numbers the report actually carries are fixed here.
const NO_HOST_PRESSURE = {
  available: 9_668 * 1024,
  swapTotal: 31_471 * 1024,
  swapFree: 31_445 * 1024
}

const PROC_PRESSURE_MEMORY = [
  'some avg10=61.40 avg60=48.22 avg300=12.09 total=98765432',
  'full avg10=44.10 avg60=30.05 avg300=8.01 total=87654321',
  ''
].join('\n')

beforeEach(() => {
  // Without this the real reader answers from the CI host's own /sys/fs/cgroup.
  setLinuxCgroupMemoryLimitReaderForTest(() => undefined)
})

afterEach(() => {
  setLinuxCgroupMemoryLimitReaderForTest(null)
  setLinuxMemoryPressureStallReaderForTest(null)
  setLinuxPseudoFileReaderForTest(null)
  setSystemMemoryInfoReaderForTest(null)
})

/** Only the listed paths exist; anything else reads as an unreadable pseudo-file. */
function fakeLinuxPseudoFiles(files: Record<string, string>): void {
  setLinuxPseudoFileReaderForTest((filePath) => files[filePath])
}

const CALM_PRESSURE = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'

// Below the reader seam: which files the procfs reader actually opens, and
// whether an absent PSI stays absent instead of reading as a calm host.
describe('reading PSI off procfs and the cgroup', () => {
  it("reads the host file and the resolved cgroup's own memory.pressure", () => {
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': '0::/user.slice/orca.scope\n',
      '/sys/fs/cgroup/user.slice/orca.scope/memory.current': '512\n',
      '/proc/pressure/memory': PROC_PRESSURE_MEMORY,
      '/sys/fs/cgroup/user.slice/orca.scope/memory.pressure':
        'some avg10=71.20 avg60=60.00 avg300=20.00 total=1\nfull avg10=58.90 avg60=41.30 avg300=9.00 total=2\n'
    })

    expect(readLinuxMemoryPressureStall('linux')).toEqual({
      host: { someAvg10: 61.4, someAvg60: 48.22, fullAvg10: 44.1, fullAvg60: 30.05 },
      cgroup: { someAvg10: 71.2, someAvg60: 60, fullAvg10: 58.9, fullAvg60: 41.3 }
    })
  })

  it('still reports the host file when the cgroup cannot be resolved', () => {
    fakeLinuxPseudoFiles({ '/proc/pressure/memory': CALM_PRESSURE })

    expect(readLinuxMemoryPressureStall('linux')).toEqual({
      host: { someAvg10: 0, someAvg60: 0 },
      cgroup: undefined
    })
  })

  it('stays silent on a kernel built without CONFIG_PSI', () => {
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': '0::/user.slice/orca.scope\n',
      '/sys/fs/cgroup/user.slice/orca.scope/memory.current': '512\n'
    })

    expect(readLinuxMemoryPressureStall('linux')).toBeUndefined()
  })
})

describe('linux PSI memory stall', () => {
  it('takes avg10 and avg60 off both the some and full lines', () => {
    expect(parseMemoryPressureStall(PROC_PRESSURE_MEMORY)).toEqual({
      someAvg10: 61.4,
      someAvg60: 48.22,
      fullAvg10: 44.1,
      fullAvg60: 30.05
    })
  })

  it('accepts a kernel that prints only the some line', () => {
    expect(parseMemoryPressureStall('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')).toEqual({
      someAvg10: 0,
      someAvg60: 0
    })
  })

  it('drops a field the kernel did not print as a number, keeping the rest', () => {
    // A truncated or unexpected line must not become a NaN masquerading as a reading.
    expect(parseMemoryPressureStall('some avg10=n/a avg60=1.5 avg300=0.00\n')).toEqual({
      someAvg60: 1.5
    })
  })

  it('says nothing rather than zero when PSI is not compiled in', () => {
    expect(parseMemoryPressureStall(undefined)).toBeUndefined()
    expect(parseMemoryPressureStall('')).toBeUndefined()
    expect(parseMemoryPressureStall('cat: /proc/pressure/memory: No such file')).toBeUndefined()
  })

  it('stays silent off Linux', () => {
    setLinuxMemoryPressureStallReaderForTest(() => ({ host: { fullAvg10: 90 } }))
    expect(readLinuxMemoryPressureStall('darwin')).toBeUndefined()
    expect(readLinuxMemoryPressureStall('win32')).toBeUndefined()
    expect(readLinuxMemoryPressureStall('linux')).toEqual({ host: { fullAvg10: 90 } })
  })

  it('never lets an unreadable /proc break the reading', () => {
    setLinuxMemoryPressureStallReaderForTest(() => {
      throw new Error('EACCES')
    })
    expect(readLinuxMemoryPressureStall('linux')).toBeUndefined()
  })
})

describe('stall in linux crash memory details', () => {
  it('names the systemd-oomd signature: high stall beside a healthy MemAvailable', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxMemoryPressureStallReaderForTest(() => ({
      host: parseMemoryPressureStall(PROC_PRESSURE_MEMORY),
      cgroup: { someAvg10: 71.2, someAvg60: 60, fullAvg10: 58.9, fullAvg60: 41.3 }
    }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryAvailableMB).toBe(9_668)
    // All four windows of both scopes, each a distinct number: any pair that swaps
    // suffixes, and any row dropped from the mapping, lands on a different value.
    expect(details.systemMemoryStallSomeAvg10Pct).toBe(61.4)
    expect(details.systemMemoryStallSomeAvg60Pct).toBe(48.22)
    expect(details.systemMemoryStallFullAvg10Pct).toBe(44.1)
    expect(details.systemMemoryStallFullAvg60Pct).toBe(30.05)
    expect(details.systemMemoryCgroupStallSomeAvg10Pct).toBe(71.2)
    expect(details.systemMemoryCgroupStallSomeAvg60Pct).toBe(60)
    expect(details.systemMemoryCgroupStallFullAvg10Pct).toBe(58.9)
    expect(details.systemMemoryCgroupStallFullAvg60Pct).toBe(41.3)
    // 9.4 GB free and swap untouched: without PSI this report reads as "not memory".
    expect(details.systemMemoryPressureSignal).toBe('mem-available-stalled')
  })

  it('leaves a calm host on the plain label', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxMemoryPressureStallReaderForTest(() => ({
      host: { someAvg10: 2.1, fullAvg10: MEMORY_STALL_HIGH_AVG10_PERCENT - 0.01 }
    }))

    expect(getSystemMemoryDetails('linux').systemMemoryPressureSignal).toBe('mem-available')
  })

  // Why literals and not the constant: the boundary case above moves with whatever
  // the constant says, so it holds at 5% or 50% alike. These two fix the number
  // itself — a threshold low enough to fire on an ordinary reclaim burst would
  // name systemd-oomd on hosts it never touched.
  it('pins the threshold to 30%, not merely to itself', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    for (const [fullAvg10, expected] of [
      [29.9, 'mem-available'],
      [30, 'mem-available-stalled']
    ] as const) {
      setLinuxMemoryPressureStallReaderForTest(() => ({ cgroup: { fullAvg10 } }))
      expect(getSystemMemoryDetails('linux').systemMemoryPressureSignal).toBe(expected)
    }
  })

  it('prefers the cgroup stall, which is the figure systemd-oomd acts on', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxMemoryPressureStallReaderForTest(() => ({
      host: { fullAvg10: 1 },
      cgroup: { fullAvg10: MEMORY_STALL_HIGH_AVG10_PERCENT }
    }))

    expect(getSystemMemoryDetails('linux').systemMemoryPressureSignal).toBe('mem-available-stalled')
  })

  it('does not let a thrashing host label our own calm cgroup as stalled', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    // A sibling cgroup is the hog: the host stalls, we do not, and whatever
    // killed us was not this. Taking the higher of the two would misname it.
    // Why 0 and not a small non-zero: 0 is what a calm cgroup actually reads,
    // and it must still count as a reading rather than fall through to the host.
    setLinuxMemoryPressureStallReaderForTest(() => ({
      host: { fullAvg10: 90 },
      cgroup: { fullAvg10: 0 }
    }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryStallFullAvg10Pct).toBe(90)
    expect(details.systemMemoryCgroupStallFullAvg10Pct).toBe(0)
    expect(details.systemMemoryPressureSignal).toBe('mem-available')
  })

  it('lets a cgroup ceiling outrank stall, since it explains the stall as well', () => {
    setSystemMemoryInfoReaderForTest(() => ({ ...NO_HOST_PRESSURE, total: 32_000 * 1024 }))
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: 2_147_483_648 }))
    setLinuxMemoryPressureStallReaderForTest(() => ({ cgroup: { fullAvg10: 88 } }))

    const details = getSystemMemoryDetails('linux')

    // The stall itself must stay readable in its own field either way.
    expect(details.systemMemoryCgroupStallFullAvg10Pct).toBe(88)
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  it('reads no PSI on macOS or Windows', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxMemoryPressureStallReaderForTest(() => ({ host: { fullAvg10: 99 } }))

    for (const platform of ['darwin', 'win32'] as const) {
      const details = getSystemMemoryDetails(platform)
      expect(Object.keys(details).some((key) => key.includes('Stall'))).toBe(false)
    }
  })

  it('reports the host reading even when Electron gives no memory info at all', () => {
    setSystemMemoryInfoReaderForTest(() => null)
    setLinuxMemoryPressureStallReaderForTest(() => ({ host: { fullAvg10: 77 } }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryStallFullAvg10Pct).toBe(77)
    // No MemAvailable to qualify, so no verdict may be claimed about the host.
    expect(details.systemMemoryPressureSignal).toBe('none')
  })

  it('emits nothing at all when every reader comes up empty', () => {
    setSystemMemoryInfoReaderForTest(() => null)
    setLinuxMemoryPressureStallReaderForTest(() => undefined)

    expect(getSystemMemoryDetails('linux')).toEqual({})
  })
})

describe('stall across a process death', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    resetPreGoneSystemMemorySamplingForTest()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    resetPreGoneSystemMemorySamplingForTest()
  })

  // Why the pair: PSI decays, so the gone-time read taken after the corpse
  // released its pages understates the stall that triggered the kill.
  it('carries the stall from before the death, not only the decayed one after', async () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    let fullAvg10 = 62.5
    setLinuxMemoryPressureStallReaderForTest(() => ({ host: { fullAvg10 } }))

    await samplePreGoneSystemMemory(1_000)
    fullAvg10 = 3.2
    const report = {
      ...getSystemMemoryDetails('linux'),
      ...preGoneSystemMemoryDetails(2_000)
    }

    expect(report.systemMemoryPreGoneStallFullAvg10Pct).toBe(62.5)
    expect(report.systemMemoryPreGonePressureSignal).toBe('mem-available-stalled')
    expect(report.systemMemoryStallFullAvg10Pct).toBe(3.2)
    expect(report.systemMemoryPressureSignal).toBe('mem-available')
  })
})
