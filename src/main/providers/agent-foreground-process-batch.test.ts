import { describe, expect, it } from 'vitest'
import { parseStrictProcessTableRows } from '../../shared/process-table-snapshot'
import { buildProcessTableIndex } from '../../shared/process-table-index'
import { resolveAgentForegroundProcessesFromIndex } from './agent-foreground-process-batch'

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
    // Unknown foreground commands are invisible to name recognition; only the shell owning its terminal proves idle.
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
})
