import * as host from '@orca/process-host'
import { writerVerdict } from './provider-process-inventory'
import { ProviderCleanupBudget } from './provider-process-exit-deadline'
import { hasUnambiguousStartTime } from '../pty-descendant-termination'
import { describe, expect, it, vi } from 'vitest'
import { parseLinuxProcStat, readPosixProcessRow } from './provider-process-row-read'

describe('parseLinuxProcStat', () => {
  it('reads parent, group and start ticks past a comm with spaces and parentheses', () => {
    const fields = ['S', '41', '4242', '4242', ...Array<string>(15).fill('0'), '987654', '0']
    expect(parseLinuxProcStat(4242, `4242 (open (code) serve) ${fields.join(' ')}`)).toEqual({
      pid: 4242,
      ppid: 41,
      pgid: 4242,
      startedAt: 'clock-tick:987654',
      startResolution: 'clock-tick',
      zombie: false
    })
  })

  it('rejects a truncated stat line', () => {
    expect(parseLinuxProcStat(4242, '4242 (opencode) S 41')).toBeNull()
  })
})

describe.runIf(process.platform !== 'win32')('readPosixProcessRow', () => {
  it('reads this process with the same start marker every time', async () => {
    const first = await readPosixProcessRow(process.pid)
    const second = await readPosixProcessRow(process.pid)
    expect(first).toMatchObject({ pid: process.pid, ppid: process.ppid })
    expect(second).toEqual(first)
  })

  it('reports a pid with no process as absent, not unverifiable', async () => {
    await expect(readPosixProcessRow(2 ** 22 + 12_345)).resolves.toBeNull()
  })
})

it('uses zoned Darwin identity, rejects birth seconds and retains old unzoned writers', async () => {
  const start = 'Tue Oct 20 12:00:00 2026',
    iso = '2026-10-20T12:00:00.000Z'
  const ps = vi.spyOn(host, 'runProcess').mockResolvedValue({
    code: 0,
    signal: null,
    stdout: `4242 1 4242 ${start} S`,
    stderr: '',
    timedOut: false
  })
  try {
    expect(await readPosixProcessRow(4242, 'darwin')).toMatchObject({ startedAt: iso })
    expect(ps).toHaveBeenCalledWith(
      expect.objectContaining({ env: expect.objectContaining({ TZ: 'UTC', LC_ALL: 'C' }) })
    )
    expect(hasUnambiguousStartTime(iso, Date.parse(iso))).toBe(false)
    if (process.platform === 'darwin') {
      expect(
        await writerVerdict(
          [{ pid: 4242, pgid: 4242, startedAt: start }],
          new ProviderCleanupBudget()
        )
      ).toBe('unknown')
    }
  } finally {
    ps.mockRestore()
  }
})
