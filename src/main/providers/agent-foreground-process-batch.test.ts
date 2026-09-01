import { describe, expect, it } from 'vitest'
import {
  buildProcessTableIndex,
  parseStrictProcessTableRows,
  ProcessTableCaptureError,
  type ProcessTableIndexStats
} from '../../shared/process-table-snapshot'
import {
  resolveAgentForegroundProcessesBatch,
  resolveAgentForegroundProcessesFromIndex
} from './agent-foreground-process'

describe('strict process-table evidence parser', () => {
  it('extracts pgid/tpgid while retaining command spacing', () => {
    expect(
      parseStrictProcessTableRows(
        ' PID PPID PGID TPGID STAT COMMAND\r\n 100 1 100 101 Ss /bin/zsh -l\r\n 101 100 101 101 S+ node /opt/codex --flag  value\r\n'
      )
    ).toEqual([
      { pid: 100, ppid: 1, pgid: 100, tpgid: 101, stat: 'Ss', command: '/bin/zsh -l' },
      {
        pid: 101,
        ppid: 100,
        pgid: 101,
        tpgid: 101,
        stat: 'S+',
        command: 'node /opt/codex --flag  value'
      }
    ])
  })

  it.each(['101 100 101 S+ node /opt/codex', '101 100 -2 101 S+ node /opt/codex'])(
    'rejects malformed/truncated captures (%s)',
    (capture) => {
      expect(() => parseStrictProcessTableRows(capture)).toThrow(ProcessTableCaptureError)
    }
  )

  it('accepts no-controlling-tty sentinels for later unverifiable classification', () => {
    expect(parseStrictProcessTableRows('100 1 100 0 Ss /bin/zsh')).toEqual([
      { pid: 100, ppid: 1, pgid: 100, tpgid: 0, stat: 'Ss', command: '/bin/zsh' }
    ])
    expect(parseStrictProcessTableRows('100 1 100 -1 Ss /bin/zsh')).toEqual([
      { pid: 100, ppid: 1, pgid: 100, tpgid: -1, stat: 'Ss', command: '/bin/zsh' }
    ])
  })
})

describe('batched foreground process correlation', () => {
  it('uses tpgid/pgid association instead of stat alone', () => {
    const rows = parseStrictProcessTableRows(
      [
        '100 1 100 101 Ss /bin/zsh',
        '101 100 100 101 S+ node /opt/not-an-agent',
        '102 100 101 101 S  node /opt/codex'
      ].join('\n')
    )
    expect(
      resolveAgentForegroundProcessesFromIndex(buildProcessTableIndex(rows), [
        { rootPid: 100, fallbackProcess: 'zsh' }
      ])
    ).toEqual([{ available: true, processName: 'codex' }])
  })

  it('returns unverifiable for a missing root or no controlling tty', () => {
    const rows = parseStrictProcessTableRows('100 1 100 0 Ss /bin/zsh')
    expect(
      resolveAgentForegroundProcessesFromIndex(buildProcessTableIndex(rows), [
        { rootPid: 100, fallbackProcess: 'zsh' },
        { rootPid: 999, fallbackProcess: 'zsh' }
      ])
    ).toEqual([
      { available: false, processName: 'zsh', reason: 'no_controlling_tty' },
      { available: false, processName: 'zsh', reason: 'root_missing' }
    ])
  })

  it.each([1, 50, 200])('captures and indexes one host table for %s panes', async (paneCount) => {
    const rows = Array.from({ length: paneCount }, (_, index) => {
      const rootPid = 10_000 + index * 2
      return [
        {
          pid: rootPid,
          ppid: 1,
          pgid: rootPid,
          tpgid: rootPid + 1,
          stat: 'Ss',
          command: '/bin/zsh'
        },
        {
          pid: rootPid + 1,
          ppid: rootPid,
          pgid: rootPid + 1,
          tpgid: rootPid + 1,
          stat: 'S',
          command: 'node /opt/codex'
        }
      ]
    }).flat()
    const stats: ProcessTableIndexStats = {
      captures: 0,
      indexBuilds: 0,
      rowVisits: 0,
      indexLookups: 0
    }
    const results = await resolveAgentForegroundProcessesBatch(
      rows
        .map((row) => (row.pid % 2 === 0 ? { rootPid: row.pid, fallbackProcess: 'zsh' } : null))
        .filter(
          (request): request is { rootPid: number; fallbackProcess: string } => request !== null
        ),
      { readRows: async () => rows, stats }
    )
    expect(results).toHaveLength(paneCount)
    expect(results.every((result) => result.processName === 'codex')).toBe(true)
    expect(stats).toMatchObject({ captures: 1, indexBuilds: 1, rowVisits: paneCount * 2 })
    expect(stats.indexLookups).toBeLessThanOrEqual(paneCount * 4)
  })
})
