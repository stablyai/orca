import { describe, expect, it } from 'vitest'
import { parseLinuxProcStat } from './linux-process-tree'

describe('parseLinuxProcStat', () => {
  it('marks a process whose group owns the terminal foreground', () => {
    const parsed = parseLinuxProcStat(
      '101 (node codex) S 100 101 100 34816 101 0 0 0 0 0 0 0 0 0 0 0 0 0'
    )

    expect(parsed).toMatchObject({
      pid: 101,
      ppid: 100,
      stat: 'S+',
      command: 'node codex',
      processGroupId: 101,
      terminalForegroundGroupId: 101
    })
  })

  it('keeps background and stopped processes out of foreground', () => {
    const parsed = parseLinuxProcStat(
      '102 (codex) T 100 102 100 34816 101 0 0 0 0 0 0 0 0 0 0 0 0 0'
    )

    expect(parsed).toMatchObject({ pid: 102, ppid: 100, stat: 'T' })
  })

  it('rejects malformed proc stat rows', () => {
    expect(parseLinuxProcStat('not a proc stat row')).toBeNull()
  })
})
