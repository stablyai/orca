import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cgroupV2AncestorDirs,
  cgroupV2MemoryDirCandidates,
  parseCgroupMemoryBytes,
  parseCgroupMemoryEvent,
  parseCgroupV2Path,
  readLinuxCgroupMemoryLimit,
  readLinuxPseudoFile,
  resolveCgroupV2MemoryDir,
  setLinuxCgroupMemoryLimitReaderForTest,
  setLinuxPseudoFileReaderForTest
} from './linux-cgroup-memory-limit'
import { setLinuxMemoryPressureStallReaderForTest } from './linux-memory-pressure-stall'
import { getSystemMemoryDetails, setSystemMemoryInfoReaderForTest } from './system-memory-details'
import {
  preGoneSystemMemoryDetails,
  resetPreGoneSystemMemorySamplingForTest,
  samplePreGoneSystemMemory
} from './pre-gone-host-memory'

// The host reading from field report 2ea53f9c: a lone renderer SIGKILLed while
// /proc/meminfo says 20 GB available and swap is 100% free.
const NO_HOST_PRESSURE = {
  total: 32_005 * 1024,
  free: 10_326 * 1024,
  available: 20_518 * 1024,
  swapTotal: 64_009 * 1024,
  swapFree: 64_009 * 1024
}

beforeEach(() => {
  // Without this the real readers answer from the CI host's own /proc and /sys.
  setLinuxMemoryPressureStallReaderForTest(() => undefined)
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

const SANDBOX_CGROUP_PATH = '0::/user.slice/user-1000.slice/app.slice/orca.scope\n'

// Everything below the seam that the reader test double skips: which directory
// the sysfs reads actually land in, and whether an unresolvable one stays quiet.
describe('cgroup v2 memory directory resolution', () => {
  it('reads the directory /proc/self/cgroup names when it exists', () => {
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': '512\n'
    })

    expect(resolveCgroupV2MemoryDir()).toBe(
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope'
    )
  })

  it('falls back to the mount root, which is our own cgroup inside a namespace', () => {
    // The sandbox case the header claims to cover: the reported path is a host
    // path that does not exist in here, and the mount root IS our cgroup.
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/memory.current': '900000000\n',
      '/sys/fs/cgroup/memory.max': '1073741824\n'
    })

    expect(resolveCgroupV2MemoryDir()).toBe('/sys/fs/cgroup')
    expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({
      maxBytes: 1_073_741_824,
      currentBytes: 900_000_000,
      // The mount root answers memory.current, which only a non-root cgroup does:
      // we are inside a namespace and anything above it is unreadable from here.
      chainReachesRoot: false
    })
  })

  it('claims nothing when neither candidate has memory.current', () => {
    // A v1-only or hybrid host: the unified root exists but carries no memory
    // controller, and the host root cgroup never has memory.current.
    fakeLinuxPseudoFiles({ '/proc/self/cgroup': SANDBOX_CGROUP_PATH })

    expect(resolveCgroupV2MemoryDir()).toBeUndefined()
    expect(readLinuxCgroupMemoryLimit('linux')).toBeUndefined()
  })

  it('reads the ceiling, the throttle and the events off the resolved directory', () => {
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': '4200000000',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.max': '4294967296',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.high': 'max\n',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.events':
        // `oom` deliberately differs from `oom_kill`: reading the wrong one here
        // would report a cgroup that went OOM without killing anything.
        'low 0\nhigh 7\nmax 2\noom 5\noom_kill 1\n'
    })

    expect(readLinuxCgroupMemoryLimit('linux')).toEqual({
      maxBytes: 4_294_967_296,
      // `max` is no ceiling, and must not surface as one just because it was read.
      highBytes: undefined,
      currentBytes: 4_200_000_000,
      // Our own scope owns the ceiling, so there is no second usage to print.
      ceilingCurrentBytes: undefined,
      oomKillCount: 1,
      maxEventCount: 2,
      highEventCount: 7,
      // No memory.current at the mount root, so it is the machine's own root
      // cgroup and nothing above our chain is hidden.
      chainReachesRoot: true
    })
  })

  it('reads memory.high and its throttle counter off the resolved directory', () => {
    // The systemd `MemoryHigh=` unit with no `MemoryMax=`: every other test gives
    // memory.high `max` or an empty string, which is indistinguishable from never
    // reading the file at all — so deleting the read, or pointing it at memory.low,
    // stays green. This is the only case that pins the throttle ceiling and the
    // `high` event counter from the sysfs file through to the report.
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': '2100000000',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.max': 'max\n',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.high': '2147483648\n',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.events':
        'low 0\nhigh 41\nmax 0\noom 0\noom_kill 0\n'
    })

    expect(readLinuxCgroupMemoryLimit('linux')).toEqual({
      maxBytes: undefined,
      highBytes: 2_147_483_648,
      currentBytes: 2_100_000_000,
      ceilingCurrentBytes: undefined,
      oomKillCount: 0,
      maxEventCount: 0,
      highEventCount: 41,
      chainReachesRoot: true
    })

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupHighMB).toBe(2_048)
    expect(details.systemMemoryCgroupHighEventCount).toBe(41)
    expect(details.systemMemoryCgroupMaxMB).toBeUndefined()
    // Throttled 41 times against a 2 GB ceiling, with 20 GB "available" beside it.
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  // The kernel enforces the MINIMUM ceiling over our cgroup and its ancestors, so
  // reading only our own level reports "no ceiling" on a snap quota slice, a
  // `MemoryMax=` on user.slice, or a Kubernetes pod cgroup — the sandboxes this
  // module names as its reason to exist — and clears the very check that would
  // have attributed the kill.
  describe('ceilings inherited from an ancestor cgroup', () => {
    const SCOPE = '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope'
    const APP_SLICE = '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice'
    const USER_SLICE = '/sys/fs/cgroup/user.slice/user-1000.slice'

    it('walks our cgroup and every ancestor up to the mount root, nearest first', () => {
      expect(cgroupV2AncestorDirs(SCOPE)).toEqual([
        SCOPE,
        APP_SLICE,
        USER_SLICE,
        '/sys/fs/cgroup/user.slice',
        '/sys/fs/cgroup'
      ])
      // Inside a cgroup namespace the mount root is our own cgroup and has no ancestors.
      expect(cgroupV2AncestorDirs('/sys/fs/cgroup')).toEqual(['/sys/fs/cgroup'])
    })

    it("takes an ancestor slice's MemoryMax when our own scope declares none", () => {
      // `snap set-quota --memory` puts MemoryMax on the parent slice, not the
      // service unit, so our own memory.max reads `max` while we are hard-capped.
      setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
      fakeLinuxPseudoFiles({
        '/proc/self/cgroup': `0::${SCOPE.slice('/sys/fs/cgroup'.length)}\n`,
        [`${SCOPE}/memory.current`]: '900000000\n',
        [`${SCOPE}/memory.max`]: 'max\n',
        [`${SCOPE}/memory.high`]: 'max\n',
        [`${USER_SLICE}/memory.max`]: '2147483648\n',
        [`${USER_SLICE}/memory.current`]: '2040000000\n'
      })

      expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({
        maxBytes: 2_147_483_648,
        currentBytes: 900_000_000,
        // Our 900 MB says nothing about a ceiling shared with our siblings.
        ceilingCurrentBytes: 2_040_000_000
      })

      const details = getSystemMemoryDetails('linux')

      expect(details.systemMemoryCgroupMaxMB).toBe(2_048)
      expect(details.systemMemoryCgroupCurrentMB).toBe(858)
      expect(details.systemMemoryCgroupCeilingCurrentMB).toBe(1_945)
      expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
    })

    it('keeps our own tighter ceiling over a looser ancestor one', () => {
      setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
      fakeLinuxPseudoFiles({
        '/proc/self/cgroup': `0::${SCOPE.slice('/sys/fs/cgroup'.length)}\n`,
        [`${SCOPE}/memory.current`]: '1000000000\n',
        [`${SCOPE}/memory.max`]: '1073741824\n',
        [`${USER_SLICE}/memory.max`]: '8589934592\n',
        [`${USER_SLICE}/memory.current`]: '5000000000\n'
      })

      expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({
        maxBytes: 1_073_741_824,
        // The binding ceiling is our own, so there is no second usage to print.
        ceilingCurrentBytes: undefined
      })
      expect(getSystemMemoryDetails('linux').systemMemoryCgroupCeilingCurrentMB).toBeUndefined()
    })

    it('takes the lowest of the chain, not the nearest declared ceiling', () => {
      // Both levels declare a MemoryMax and the tighter one is the ancestor's,
      // which is the only arrangement that separates "lowest in the chain" from
      // "first one found walking up".
      setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
      fakeLinuxPseudoFiles({
        '/proc/self/cgroup': `0::${SCOPE.slice('/sys/fs/cgroup'.length)}\n`,
        [`${SCOPE}/memory.current`]: '1800000000\n',
        [`${SCOPE}/memory.max`]: '4294967296\n',
        [`${USER_SLICE}/memory.max`]: '2147483648\n',
        [`${USER_SLICE}/memory.current`]: '2000000000\n'
      })

      expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({
        maxBytes: 2_147_483_648,
        currentBytes: 1_800_000_000,
        ceilingCurrentBytes: 2_000_000_000
      })
      expect(getSystemMemoryDetails('linux').systemMemoryCgroupMaxMB).toBe(2_048)
    })

    it('resolves memory.max and memory.high independently, each at its own level', () => {
      // MemoryMax on our scope, MemoryHigh on the app slice above it, and a looser
      // MemoryMax two levels up: every value here is distinct, so taking the wrong
      // level, the wrong file, or the higher of a chain lands on a different number.
      setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
      fakeLinuxPseudoFiles({
        '/proc/self/cgroup': `0::${SCOPE.slice('/sys/fs/cgroup'.length)}\n`,
        [`${SCOPE}/memory.current`]: '1200000000\n',
        [`${SCOPE}/memory.max`]: '4294967296\n',
        [`${SCOPE}/memory.high`]: 'max\n',
        [`${APP_SLICE}/memory.high`]: '1610612736\n',
        [`${APP_SLICE}/memory.max`]: 'max\n',
        [`${APP_SLICE}/memory.current`]: '1500000000\n',
        [`${USER_SLICE}/memory.max`]: '8589934592\n'
      })

      expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({
        maxBytes: 4_294_967_296,
        highBytes: 1_610_612_736,
        currentBytes: 1_200_000_000,
        // The lowest ceiling of the two is the app slice's high, so its usage ships.
        ceilingCurrentBytes: 1_500_000_000
      })

      const details = getSystemMemoryDetails('linux')

      expect(details.systemMemoryCgroupMaxMB).toBe(4_096)
      expect(details.systemMemoryCgroupHighMB).toBe(1_536)
      expect(details.systemMemoryCgroupCurrentMB).toBe(1_144)
      expect(details.systemMemoryCgroupCeilingCurrentMB).toBe(1_431)
    })

    it("holds the ancestor's usage against a MemoryMax that undercuts our own MemoryHigh", () => {
      // The mirror of the case above, and the only one that fixes WHICH of the
      // two ceilings binds: everywhere else memory.high is the lower of the
      // pair, so "the binding ceiling is always memory.high's" reads the same
      // number. Here the hard cap is the slice's and the soft throttle is ours,
      // so the usage to hold against it is the slice's — reading memory.high's
      // level instead prints our own 858 MB, or nothing at all.
      setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
      fakeLinuxPseudoFiles({
        '/proc/self/cgroup': `0::${SCOPE.slice('/sys/fs/cgroup'.length)}\n`,
        [`${SCOPE}/memory.current`]: '900000000\n',
        [`${SCOPE}/memory.max`]: 'max\n',
        [`${SCOPE}/memory.high`]: '6442450944\n',
        [`${USER_SLICE}/memory.max`]: '2147483648\n',
        [`${USER_SLICE}/memory.high`]: 'max\n',
        [`${USER_SLICE}/memory.current`]: '2040000000\n'
      })

      expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({
        maxBytes: 2_147_483_648,
        highBytes: 6_442_450_944,
        currentBytes: 900_000_000,
        ceilingCurrentBytes: 2_040_000_000
      })

      const details = getSystemMemoryDetails('linux')

      expect(details.systemMemoryCgroupCurrentMB).toBe(858)
      expect(details.systemMemoryCgroupCeilingCurrentMB).toBe(1_945)
      expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
    })
  })

  // An absent `memory.max` means "uncapped" only over the levels we could read,
  // and inside a cgroup namespace that is our own cgroup and nothing above it.
  // Without this flag the report cannot tell a fully walked chain from a
  // one-level one, so a pod or slice ceiling above the namespace root reads as
  // "no cgroup ceiling" — clearing the very check meant to catch it.
  describe('whether the walked chain reaches the machine root cgroup', () => {
    it('says the chain stops short when the mount root is a namespace root', () => {
      setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
      // A container: our cgroup is a child of the mount root, which answers
      // memory.current and so is itself a cgroup. Every visible level reads
      // `max`, while the ceiling that binds us sits on the pod cgroup ABOVE the
      // namespace root, where nothing in here can read it.
      fakeLinuxPseudoFiles({
        '/proc/self/cgroup': '0::/init.scope\n',
        '/sys/fs/cgroup/init.scope/memory.current': '2000000000\n',
        '/sys/fs/cgroup/init.scope/memory.max': 'max\n',
        // Deliberately memory.current and NOT memory.max: probing the wrong file
        // at the mount root reads this namespace root as the machine's own.
        '/sys/fs/cgroup/memory.current': '2100000000\n'
      })

      expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({
        maxBytes: undefined,
        currentBytes: 2_000_000_000,
        chainReachesRoot: false
      })

      const details = getSystemMemoryDetails('linux')

      expect(details.systemMemoryCgroupMaxMB).toBeUndefined()
      expect(details.systemMemoryCgroupChainReachesRoot).toBe(false)
      // The label stays plain — the flag is what stops that being read as proof
      // there is no ceiling.
      expect(details.systemMemoryPressureSignal).toBe('mem-available')
    })

    it('says the chain is complete when the mount root is the machine root', () => {
      setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
      // A native host: the root cgroup has no memory.current, so an absent
      // ceiling really is absent all the way up.
      fakeLinuxPseudoFiles({
        '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
        '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': '512\n'
      })

      expect(readLinuxCgroupMemoryLimit('linux')).toMatchObject({ chainReachesRoot: true })
      expect(getSystemMemoryDetails('linux').systemMemoryCgroupChainReachesRoot).toBe(true)
    })

    it('never lets the flag alone stand in for a reading', () => {
      // The flag always resolves, so counting it as a measured field would ship a
      // Cgroup row on every Linux host that has no v2 memory controller at all.
      fakeLinuxPseudoFiles({ '/proc/self/cgroup': SANDBOX_CGROUP_PATH })
      setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)

      expect(readLinuxCgroupMemoryLimit('linux')).toBeUndefined()
      expect(getSystemMemoryDetails('linux').systemMemoryCgroupChainReachesRoot).toBeUndefined()
    })
  })

  it('does not turn a zero-length ceiling file into a 0 MB cap', () => {
    // A sandbox that stubs /sys/fs/cgroup with empty files: `Number('')` is 0, so
    // dropping the empty-string term ships a 0 MB ceiling and labels the report
    // cgroup-capped — a killer named off a file that measured nothing.
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxMemoryPressureStallReaderForTest(() => undefined)
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': '4200000000',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.max': '',
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.high': ''
    })

    expect(readLinuxCgroupMemoryLimit('linux')).toEqual({
      maxBytes: undefined,
      highBytes: undefined,
      currentBytes: 4_200_000_000,
      ceilingCurrentBytes: undefined,
      oomKillCount: undefined,
      maxEventCount: undefined,
      highEventCount: undefined,
      chainReachesRoot: true
    })

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupMaxMB).toBeUndefined()
    expect(details.systemMemoryCgroupHighMB).toBeUndefined()
    expect(details.systemMemoryCgroupCurrentMB).toBe(4_005)
    expect(details.systemMemoryPressureSignal).toBe('mem-available')
  })

  it('says nothing rather than a row of undefineds when the files are garbage', () => {
    fakeLinuxPseudoFiles({
      '/proc/self/cgroup': SANDBOX_CGROUP_PATH,
      '/sys/fs/cgroup/user.slice/user-1000.slice/app.slice/orca.scope/memory.current': 'max'
    })

    expect(readLinuxCgroupMemoryLimit('linux')).toBeUndefined()
  })
})

describe('linux cgroup v2 memory limit', () => {
  it('takes the unified-hierarchy line, not a v1 controller line', () => {
    const procSelfCgroup = [
      '12:pids:/user.slice/user-1000.slice',
      '1:name=systemd:/user.slice/user-1000.slice',
      '0::/user.slice/user-1000.slice/user@1000.service/app.slice/orca.scope'
    ].join('\n')
    expect(parseCgroupV2Path(procSelfCgroup)).toBe(
      '/user.slice/user-1000.slice/user@1000.service/app.slice/orca.scope'
    )
    expect(parseCgroupV2Path('12:pids:/user.slice')).toBeUndefined()
  })

  it('probes the mount root too, because a sandbox mounts our cgroup there', () => {
    expect(cgroupV2MemoryDirCandidates('/user.slice/orca.scope')).toEqual([
      '/sys/fs/cgroup/user.slice/orca.scope',
      '/sys/fs/cgroup'
    ])
    // A cgroup namespace already reports "/", so the root is the only candidate.
    expect(cgroupV2MemoryDirCandidates('/')).toEqual(['/sys/fs/cgroup'])
    expect(cgroupV2MemoryDirCandidates(undefined)).toEqual(['/sys/fs/cgroup'])
  })

  it('reads an unreadable pseudo-file as absent instead of throwing', () => {
    // The real disk reader, past the seam: the test double answers `undefined` for
    // a missing path, which is what the swallow PRODUCES, so it can never exercise
    // it. Without the swallow the first hidden file on a hardened host or a partial
    // cgroup tree aborts the whole reading, taking the readable fields with it.
    setLinuxPseudoFileReaderForTest(null)

    expect(readLinuxPseudoFile('/proc/orca-no-such-directory/memory.max')).toBeUndefined()
  })

  it('reads back the text of the file it was handed, per path', () => {
    // Every field on this branch comes out of one readFileSync, and the seam
    // double stands in for it everywhere else — so deleting it, dropping the utf8
    // encoding (a Buffer has no `.trim()`, and the swallow eats the TypeError) or
    // ignoring the argument for one fixed path each leave the whole reading silent
    // on real Linux with every other test green. Temp files, not /proc: macOS runs
    // this suite too.
    setLinuxPseudoFileReaderForTest(null)
    const dir = mkdtempSync(join(tmpdir(), 'orca-cgroup-read-'))
    try {
      writeFileSync(join(dir, 'memory.max'), '2147483648\n')
      writeFileSync(join(dir, 'memory.current'), '900000000\n')

      expect(readLinuxPseudoFile(join(dir, 'memory.max'))).toBe('2147483648\n')
      expect(readLinuxPseudoFile(join(dir, 'memory.current'))).toBe('900000000\n')
      expect(parseCgroupMemoryBytes(readLinuxPseudoFile(join(dir, 'memory.max')))).toBe(
        2_147_483_648
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads `max` as no limit rather than as a numeric ceiling', () => {
    expect(parseCgroupMemoryBytes('max\n')).toBeUndefined()
    expect(parseCgroupMemoryBytes('2147483648\n')).toBe(2_147_483_648)
    expect(parseCgroupMemoryBytes(undefined)).toBeUndefined()
  })

  it('pulls oom_kill out of memory.events', () => {
    // A cgroup can go OOM and reclaim without killing anything, so `oom` runs
    // ahead of `oom_kill` on a real host and only the latter attributes a death.
    const events = 'low 0\nhigh 12\nmax 3\noom 5\noom_kill 1\noom_group_kill 0\n'
    expect(parseCgroupMemoryEvent(events, 'oom_kill')).toBe(1)
    expect(parseCgroupMemoryEvent(events, 'oom')).toBe(5)
    expect(parseCgroupMemoryEvent(events, 'high')).toBe(12)
    // A prefix or substring match would answer `oom_kill` with `oom`'s count.
    expect(parseCgroupMemoryEvent('low 0\nhigh 0\noom 5\n', 'oom_kill')).toBeUndefined()
  })

  it('stays silent off Linux', () => {
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: 1 }))
    expect(readLinuxCgroupMemoryLimit('darwin')).toBeUndefined()
    expect(readLinuxCgroupMemoryLimit('win32')).toBeUndefined()
    expect(readLinuxCgroupMemoryLimit('linux')).toEqual({ maxBytes: 1 })
  })

  it('never lets a sysfs failure break the reading', () => {
    setLinuxCgroupMemoryLimitReaderForTest(() => {
      throw new Error('EACCES')
    })
    expect(readLinuxCgroupMemoryLimit('linux')).toBeUndefined()
  })
})

describe('cgroup-capped linux crash memory details', () => {
  it('carries the ceiling and the kernel oom_kill counter the host reading cannot see', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({
      maxBytes: 1_073_741_824,
      currentBytes: 1_020_000_000,
      oomKillCount: 1,
      maxEventCount: 4
    }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryAvailableMB).toBe(20_518)
    expect(details.systemMemoryCgroupMaxMB).toBe(1024)
    expect(details.systemMemoryCgroupCurrentMB).toBe(973)
    expect(details.systemMemoryCgroupOomKillCount).toBe(1)
    expect(details.systemMemoryCgroupMaxEventCount).toBe(4)
    // The whole point: 20 GB "available" must no longer read as "no ceiling".
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  it('keeps the plain label when the cgroup declares no ceiling', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ oomKillCount: 0 }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupOomKillCount).toBe(0)
    expect(details.systemMemoryCgroupMaxMB).toBeUndefined()
    expect(details.systemMemoryPressureSignal).toBe('mem-available')
  })

  it('keeps the plain label when the ceiling is not below host RAM', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    // A container whose memory.max was set at or above the whole machine: a
    // ceiling, but not one that made the 20 GB beside it unreachable, so it
    // explains nothing. Both sides of the boundary, because a comparison that
    // rejects only the equal case still names a killer on the larger one.
    for (const ceilingMB of [32_005, 49_152]) {
      setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: ceilingMB * 1024 * 1024 }))

      const details = getSystemMemoryDetails('linux')

      expect(details.systemMemoryCgroupMaxMB).toBe(ceilingMB)
      expect(details.systemMemoryPressureSignal).toBe('mem-available')
    }
  })

  it('treats a ceiling as capping when the host total is unreadable', () => {
    // MemTotal missing but MemAvailable present: the comparison that would clear
    // this ceiling cannot be made, so the ceiling must not be waved through. The
    // value is deliberately huge — nothing but the unknown-total term can cap it.
    const { total: _total, ...noTotal } = NO_HOST_PRESSURE
    setSystemMemoryInfoReaderForTest(() => noTotal)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: 512 * 1024 * 1024 * 1024 }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryTotalMB).toBeUndefined()
    expect(details.systemMemoryCgroupMaxMB).toBe(524_288)
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  it('caps on memory.high alone, which throttles us long before memory.max would', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({
      maxBytes: undefined,
      highBytes: 2_147_483_648
    }))

    const details = getSystemMemoryDetails('linux')

    expect(details.systemMemoryCgroupHighMB).toBe(2_048)
    expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
  })

  it('takes the lower ceiling whichever of MemoryHigh and MemoryMax it is', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    // The systemd pair, run both ways round: one of them sits above the host's
    // 32005 MB and so caps nothing, and only the other explains a kill with
    // 20 GB "available" beside it. Both orders, because with memory.high always
    // the lower of the two, "take memory.high and ignore memory.max" is
    // indistinguishable from taking the minimum.
    for (const [maxMB, highMB] of [
      [49_152, 2_048],
      [2_048, 49_152]
    ]) {
      setLinuxCgroupMemoryLimitReaderForTest(() => ({
        maxBytes: maxMB * 1024 * 1024,
        highBytes: highMB * 1024 * 1024
      }))

      const details = getSystemMemoryDetails('linux')

      expect(details.systemMemoryCgroupMaxMB).toBe(maxMB)
      expect(details.systemMemoryCgroupHighMB).toBe(highMB)
      expect(details.systemMemoryPressureSignal).toBe('mem-available-cgroup-capped')
    }
  })

  it('adds nothing on a host with no v2 memory controller', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => undefined)

    const details = getSystemMemoryDetails('linux')

    expect(Object.keys(details).some((key) => key.includes('Cgroup'))).toBe(false)
    expect(details.systemMemoryPressureSignal).toBe('mem-available')
  })

  it('reads none of this on macOS or Windows', () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    setLinuxCgroupMemoryLimitReaderForTest(() => ({ maxBytes: 1_073_741_824 }))

    for (const platform of ['darwin', 'win32'] as const) {
      const details = getSystemMemoryDetails(platform)
      expect(Object.keys(details).some((key) => key.includes('Cgroup'))).toBe(false)
    }
  })
})

// Why the pair and not one reading: an absolute oom_kill count says nothing —
// the cgroup may have OOMed an hour ago. Only the STEP across the death proves
// the kernel did this one, and an unchanged counter rules the cgroup out.
describe('oom_kill counter across a process death', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    resetPreGoneSystemMemorySamplingForTest()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    resetPreGoneSystemMemorySamplingForTest()
  })

  it('reports the pre-gone counter beside the gone-time one', async () => {
    setSystemMemoryInfoReaderForTest(() => NO_HOST_PRESSURE)
    let oomKillCount = 3
    setLinuxCgroupMemoryLimitReaderForTest(() => ({
      maxBytes: 4_294_967_296,
      currentBytes: 4_200_000_000,
      oomKillCount
    }))

    await samplePreGoneSystemMemory(1_000)
    oomKillCount = 4
    const report = {
      ...getSystemMemoryDetails('linux'),
      ...preGoneSystemMemoryDetails(2_500)
    }

    expect(report.systemMemoryPreGoneCgroupOomKillCount).toBe(3)
    expect(report.systemMemoryCgroupOomKillCount).toBe(4)
    expect(report.systemMemoryPreGoneSampleAgeMs).toBe(1_500)
    expect(report.systemMemoryPreGonePressureSignal).toBe('mem-available-cgroup-capped')
  })
})
