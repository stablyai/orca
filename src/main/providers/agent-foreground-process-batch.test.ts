import { describe, expect, it } from 'vitest'
import { parseStrictProcessTableRows } from '../../shared/process-table-snapshot'
import {
  buildProcessTableIndex,
  type ProcessTableIndexStats
} from '../../shared/process-table-index'
import {
  resolveAgentForegroundProcessesBatch,
  resolveAgentForegroundProcessesFromIndex
} from './agent-foreground-process-batch'

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
    ).toEqual([{ available: true, processName: 'codex', shellOwnsEveryTtyProcessGroup: false }])
  })

  it('reports whether the shell itself owns the terminal, named process or not', () => {
    // The only host-observable "nothing is running here". pid 200's own pgid owns the terminal;
    // pid 300 has an unrecognized command in the foreground, which nothing else here can see.
    const rows = parseStrictProcessTableRows(
      [
        '200 1 200 200 Ss /bin/zsh',
        '300 1 300 301 Ss /bin/zsh',
        '301 300 301 301 S+ vim notes.md'
      ].join('\n')
    )
    expect(
      resolveAgentForegroundProcessesFromIndex(buildProcessTableIndex(rows), [
        { rootPid: 200, fallbackProcess: 'zsh' },
        { rootPid: 300, fallbackProcess: 'zsh' }
      ])
    ).toEqual([
      { available: true, processName: null, shellOwnsEveryTtyProcessGroup: true },
      { available: true, processName: null, shellOwnsEveryTtyProcessGroup: false }
    ])
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
