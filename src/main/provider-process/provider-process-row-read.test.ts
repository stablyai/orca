import { describe, expect, it } from 'vitest'
import { parseLinuxProcStat } from './provider-process-row-read'

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
