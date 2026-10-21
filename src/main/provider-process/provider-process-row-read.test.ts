import { describe, expect, it } from 'vitest'
import { parseLinuxProcStat, readPosixProcessRow } from './provider-process-row-read'

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
