import { describe, expect, it } from 'vitest'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import { judgeRexChildren } from './rex-process-inspection'

const shell: ProcessTableRow = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  tpgid: 100,
  tty: 'ttys001',
  stat: 'S+',
  command: '-bash'
}
const job: ProcessTableRow = {
  pid: 101,
  ppid: 100,
  pgid: 101,
  tpgid: 100,
  tty: 'ttys001',
  stat: 'S',
  command: 'sleep 60'
}

describe('Rex process census', () => {
  it('does not treat foreground shell as absence of background or reparented jobs', () => {
    expect(judgeRexChildren([shell], 100)).toBe('no-children')
    expect(judgeRexChildren([shell, job], 100)).toBe('children')
    expect(judgeRexChildren([shell, { ...job, ppid: 1 }], 100)).toBe('children')
    expect(judgeRexChildren([shell, { ...job, tty: '??' }], 100)).toBe('children')
    expect(judgeRexChildren([shell, { ...job, stat: 'T' }], 100)).toBe('children')
    expect(judgeRexChildren([shell, { ...job, stat: 'Z' }], 100)).toBe('no-children')
  })
  it('does not prove idle for missing or unreadable root, missing tty, or changed foreground group', () => {
    expect(judgeRexChildren([job], 100)).toBe('unverifiable')
    expect(judgeRexChildren([{ ...shell, command: '(bash)' }], 100)).toBe('unverifiable')
    expect(judgeRexChildren([{ ...shell, command: '' }], 100)).toBe('unverifiable')
    expect(judgeRexChildren([{ ...shell, pgid: -1, tpgid: -1 }], 100)).toBe('unverifiable')
    expect(judgeRexChildren([{ ...shell, tty: '??' }], 100)).toBe('unverifiable')
    expect(judgeRexChildren([{ ...shell, tpgid: 101 }], 100)).toBe('unverifiable')
  })
})
