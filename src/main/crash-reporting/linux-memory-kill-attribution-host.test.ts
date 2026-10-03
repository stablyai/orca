import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { readLinuxCgroupMemoryLimit, resolveCgroupV2MemoryDir } from './linux-cgroup-memory-limit'
import { readLinuxMemoryPressureStall } from './linux-memory-pressure-stall'
import { getSystemMemoryDetails, setSystemMemoryInfoReaderForTest } from './system-memory-details'

// Why a live-kernel test: every other test here feeds the readers through the
// pseudo-file seam, which proves the parsing and not that the files the seam
// stands in for exist where the readers look. Ubuntu CI is cgroup v2 with PSI,
// so it is the one place a real /proc and /sys can vouch for that. Asserts only
// what holds on ANY such host — a cgroup namespace included — so no ceiling,
// no chain-reaches-root, no host values.
//
// Why read rather than existsSync: a CONFIG_PSI_DEFAULT_DISABLED kernel keeps
// /proc/pressure/memory but answers EOPNOTSUPP, and the root cgroup (`0::/`,
// no systemd) has no memory.current — both would fail here falsely.
function readableOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

const LIVE_CGROUP_V2_PSI_HOST =
  process.platform === 'linux' &&
  /^some avg10=/m.test(readableOrEmpty('/proc/pressure/memory')) &&
  existsSync('/sys/fs/cgroup/cgroup.controllers') &&
  /^0::\/.+$/m.test(readableOrEmpty('/proc/self/cgroup'))

const STALL_KEYS = ['someAvg10', 'someAvg60', 'fullAvg10', 'fullAvg60'] as const

function memAvailableKBFromProcMeminfo(): number | undefined {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))
  return match ? Number(match[1]) : undefined
}

describe.runIf(LIVE_CGROUP_V2_PSI_HOST)(
  'Linux readers against a live cgroup v2 + PSI kernel',
  () => {
    afterEach(() => {
      setSystemMemoryInfoReaderForTest(null)
    })

    it('reads finite host PSI averages within 0-100% off /proc/pressure/memory', () => {
      const host = readLinuxMemoryPressureStall()?.host
      expect(host).toBeDefined()
      for (const key of STALL_KEYS) {
        const percent = host?.[key]
        expect(percent, key).toBeTypeOf('number')
        expect(percent, key).toBeGreaterThanOrEqual(0)
        expect(percent, key).toBeLessThanOrEqual(100)
      }
    })

    it('resolves a cgroup memory dir that exists on disk and reads its memory.current', () => {
      const dir = resolveCgroupV2MemoryDir()
      expect(dir).toBeDefined()
      expect(existsSync(`${dir}/memory.current`)).toBe(true)
      const limit = readLinuxCgroupMemoryLimit()
      expect(limit?.currentBytes).toBeTypeOf('number')
      expect(limit?.chainReachesRoot).toBeTypeOf('boolean')
    })

    it('emits stall and cgroup fields under a mem-available label', () => {
      // vitest is not Electron, so process.getSystemMemoryInfo is absent; hand the
      // reader the kernel's own MemAvailable so the label has a reading to sit on.
      const availableKB = memAvailableKBFromProcMeminfo()
      expect(availableKB).toBeTypeOf('number')
      setSystemMemoryInfoReaderForTest(() => ({ available: availableKB }))

      const details = getSystemMemoryDetails('linux')
      expect(details.systemMemoryStallSomeAvg10Pct).toBeTypeOf('number')
      expect(Object.keys(details).some((key) => key.startsWith('systemMemoryCgroup'))).toBe(true)
      expect(details.systemMemoryPressureSignal).toMatch(/^mem-available/)
    })
  }
)
