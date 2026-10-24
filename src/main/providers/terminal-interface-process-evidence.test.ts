import { describe, expect, it } from 'vitest'
import { terminalInterfaceEvidenceFromRows } from './terminal-interface-process-evidence'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

const shell: ProcessTableRow = {
  pid: 10,
  ppid: 1,
  pgid: 10,
  tpgid: 10,
  tty: 'pts/1',
  stat: 'Ss',
  command: '/bin/bash'
}
const agent: ProcessTableRow = {
  pid: 20,
  ppid: 10,
  pgid: 20,
  tpgid: 10,
  tty: 'pts/1',
  stat: 'T',
  command: 'claude'
}
describe('physical shell ownership, separate from lifetime', () => {
  it('releases Ctrl+Z presentation but preserves the stopped child; root exec cannot borrow a tool shell', () => {
    expect(terminalInterfaceEvidenceFromRows([shell, agent], 10, 0, '/bin/bash')).toEqual({
      shellForeground: true,
      children: 'children',
      capturedAgeMs: 0
    })
    const execAgent = { ...shell, command: 'claude' }
    const toolShell = { ...shell, pid: 30, ppid: 10, command: '/bin/bash' }
    expect(
      terminalInterfaceEvidenceFromRows([execAgent, toolShell], 10, 0, '/bin/bash').children
    ).toBe('unverifiable')
    expect(terminalInterfaceEvidenceFromRows([shell], 10, 0, '/bin/bash').children).toBe(
      'no-children'
    )
    expect(terminalInterfaceEvidenceFromRows([shell], 10, 1001, '/bin/bash').children).toBe(
      'unverifiable'
    )
  })
  it('proves nested shell control without removing nested, stopped or background lifetime children', () => {
    const root = { ...shell, command: '/bin/zsh', tpgid: 20 }
    const nested = { ...shell, pid: 20, ppid: 10, pgid: 20, tpgid: 20, command: '/bin/sh' }
    const work = { ...agent, pid: 30, ppid: 20, pgid: 30, tpgid: 20, stat: 'S' }
    const evidence = (rows: ProcessTableRow[]) =>
      terminalInterfaceEvidenceFromRows(rows, 10, 0, '/bin/zsh')
    expect(evidence([root, nested])).toMatchObject({ shellForeground: true, children: 'children' })
    expect(evidence([root, nested, work])).toMatchObject({
      shellForeground: true,
      children: 'children'
    })
    expect(evidence([root, nested, { ...work, stat: 'T' }]).children).toBe('children')
    for (const rows of [
      [root, nested, { ...work, pgid: 20 }],
      [root, { ...nested, stat: 'T' }],
      [root, { ...nested, tty: 'pts/2' }],
      [root, { ...nested, ppid: 99 }],
      [root, { ...nested, ppid: 30 }, { ...work, ppid: 10, command: 'vim' }],
      [{ ...root, command: 'claude' }, nested],
      [root, { ...nested, ppid: 30 }, { ...work, ppid: 20, command: '/bin/bash' }]
    ]) {
      expect(evidence(rows).shellForeground).toBe(false)
    }
  })
  it('admits the actual login launch chain but never an arbitrary nested matching shell', () => {
    const login = { ...shell, command: '/usr/bin/login' }
    const childShell = { ...shell, pid: 11, ppid: 10, pgid: 11, tpgid: 11 }
    expect(
      terminalInterfaceEvidenceFromRows([login, childShell], 10, 0, '/bin/bash', true).children
    ).toBe('no-children')
    expect(
      terminalInterfaceEvidenceFromRows([login, childShell], 10, 0, '/bin/bash', false).children
    ).toBe('unverifiable')
  })
})
