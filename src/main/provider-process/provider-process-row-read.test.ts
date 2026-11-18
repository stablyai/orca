import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseLinuxProcStat, readPosixProcessRow } from './provider-process-row-read'
import { setLibprocAddonForTests } from '../../shared/process-observation/darwin/libproc-addon'
import { resetNativeReadsForTests } from '../../shared/process-observation/darwin/libproc-native-reads'

// Pin the exact-birth helper fallback to a failed read so fail-closed results are deterministic.
vi.mock('./provider-exec-process-row', () => ({
  readProviderExecProcessRow: vi.fn(async () => 'unverifiable')
}))

afterEach(() => {
  setLibprocAddonForTests(undefined)
  resetNativeReadsForTests()
  vi.unstubAllEnvs()
})

it('keeps recorded UTC seconds after native recovery without discarding precise identity', async () => {
  vi.stubEnv('TZ', 'Pacific/Honolulu')
  const row = {
    pid: 4242,
    ppid: 777,
    pgid: 4242,
    tpgid: 0,
    tdev: -1,
    status: 2,
    flags: 0,
    sessionLeader: true,
    startSec: 1700000000,
    startUsec: 123456,
    comm: 'node'
  }
  setLibprocAddonForTests({ readProcessTable: async () => [row] })
  await expect(readPosixProcessRow(4242, 'second', 'darwin')).resolves.toEqual({
    pid: 4242,
    ppid: 777,
    pgid: 4242,
    startedAt: '2023-11-14T22:13:20.000Z',
    startResolution: 'second'
  })
  await expect(readPosixProcessRow(4242, 'microsecond', 'darwin')).resolves.toEqual({
    pid: 4242,
    ppid: 777,
    pgid: 4242,
    startedAt: 'microsecond:1700000000:123456',
    startResolution: 'microsecond'
  })
  resetNativeReadsForTests()
  setLibprocAddonForTests({ readProcessTable: async () => [{ ...row, startUsec: undefined }] })
  await expect(readPosixProcessRow(4242, 'microsecond', 'darwin')).resolves.toBe('unverifiable')
  setLibprocAddonForTests(null)
  await expect(readPosixProcessRow(4242, 'microsecond', 'darwin')).resolves.toBe('unverifiable')
})

describe('parseLinuxProcStat', () => {
  it('reads parent, group and start ticks past a comm with spaces and parentheses', () => {
    const fields = ['S', '41', '4242', '4242', ...Array<string>(15).fill('0'), '987654', '0']
    expect(parseLinuxProcStat(4242, `4242 (open (code) serve) ${fields.join(' ')}`)).toEqual({
      pid: 4242,
      ppid: 41,
      pgid: 4242,
      startedAt: 'clock-tick:987654',
      startResolution: 'clock-tick'
    })
  })
})
