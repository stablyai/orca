import { describe, expect, it, vi } from 'vitest'
import { parseShellForegroundRows } from '../../../shared/process-table-snapshot'

const { terminalRowsMock } = vi.hoisted(() => ({ terminalRowsMock: vi.fn() }))
vi.mock('./terminal-process-rows', () => ({
  normalizePtyTty: (tty: string | null | undefined) => tty,
  readTerminalTty: async () => 'pts/0',
  readPtyTerminalRows: terminalRowsMock,
  readTerminalPs: async () => null
}))
vi.mock('./node-pty-pts-name', () => ({ readPtsName: () => 'pts/0' }))

import { observePtyForeground } from './pty-master-foreground-observation'

describe('observePtyForeground with a Docker container sharing the pts (#39488)', () => {
  it('parses a sid column so rows can be grouped by session', () => {
    const rows = parseShellForegroundRows(
      [
        '334240 334217 334240 334240 334240 Ss+ sleep 900',
        '58824 58821 58824 58826 58824 Ss+ /bin/sh -l',
        '58826 58824 58826 58826 58824 S+ claude --version'
      ].join('\n'),
      { strict: true }
    )
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ pid: 334240, sid: 334240, tpgid: 334240 })
    expect(rows[1]).toMatchObject({ pid: 58824, sid: 58824, tpgid: 58826 })
    expect(rows[2]).toMatchObject({ pid: 58826, sid: 58824, tpgid: 58826 })
  })

  it('ignores a container process whose session differs from the shell', async () => {
    // The container (PID 334240, SID 334240, TPGID 334240) shares pts/0 with the
    // agent (PID 58826, SID 58824, TPGID 58826). The old code required every row
    // on the pts to agree on TPGID; the container's row made that impossible (#39488).
    terminalRowsMock.mockResolvedValue([
      {
        pid: 334240,
        ppid: 334217,
        pgid: 334240,
        tpgid: 334240,
        sid: 334240,
        stat: 'Ss+',
        command: 'sleep 900'
      },
      {
        pid: 58824,
        ppid: 58821,
        pgid: 58824,
        tpgid: 58826,
        sid: 58824,
        stat: 'Ss+',
        command: '/bin/sh -l'
      },
      {
        pid: 58826,
        ppid: 58824,
        pgid: 58826,
        tpgid: 58826,
        sid: 58824,
        stat: 'S+',
        command: 'claude --version'
      }
    ])
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      // ptsName comes from the readPtsName mock; only pid and the group reader are read off proc.
      const proc = { pid: 58824, getForegroundProcessGroup: () => 58826 }
      const sample = await observePtyForeground(proc, () => true, Date.now() + 1_000)

      // With every pts row checked, the container's TPGID fails both coherence attempts.
      expect(sample).toMatchObject({
        verdict: 'observed',
        foregroundKind: 'non-shell',
        foregroundPgid: 58826
      })
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
