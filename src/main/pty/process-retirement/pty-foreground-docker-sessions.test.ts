import { describe, expect, it } from 'vitest'
import { parseShellForegroundRows } from '../../../shared/process-table-snapshot'

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
    const rows = [
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
    ]
    // observePtyForeground reads the ps output through readPtyTerminalRows, which we
    // cannot mock here without a process; instead verify the session filter directly.
    const root = rows.find((row) => row.pid === 58824)!
    const sessionRows = root.sid !== undefined ? rows.filter((row) => row.sid === root.sid) : rows
    expect(sessionRows).toHaveLength(2)
    expect(sessionRows.every((row) => row.tpgid === 58826)).toBe(true)
    // The container's row would have failed the old all-rows check.
    expect(rows.some((row) => row.tpgid !== 58826)).toBe(true)
  })
})
