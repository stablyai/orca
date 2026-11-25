import { describe, expect, it, vi } from 'vitest'

type Row = { pid: number; pgid: number; zombie?: true }
type Read = Row[] | 'throw'

const { table } = vi.hoisted((): { table: { reads: Read[] } } => ({ table: { reads: [] } }))
vi.mock('../../pty/process-retirement/pty-descendant-termination', () => ({
  readProcessTable: async () => {
    const next = table.reads.length > 1 ? table.reads.shift()! : table.reads[0]!
    if (next === 'throw') {
      throw new Error('ps failed')
    }
    return { rows: next.map((row) => ({ ppid: 1, startedAt: '', ...row })), capturedAtMs: 0 }
  }
}))

import { shutdownProcessGroupsStillLive } from './terminal-descendant-shutdown'

describe('session process groups after teardown', () => {
  it('waits out a straggler that exits within the drain window', async () => {
    table.reads = [[{ pid: 7, pgid: 42 }], []]
    await expect(shutdownProcessGroupsStillLive(new Set([42]), 1_000)).resolves.toBe(false)
  })

  it('reports a survivor that outlives the drain window', async () => {
    table.reads = [[{ pid: 7, pgid: 42 }]]
    await expect(shutdownProcessGroupsStillLive(new Set([42]), 0)).resolves.toBe(true)
  })

  it('ignores zombies and other groups, and treats an unreadable table as unknown', async () => {
    table.reads = [
      [
        { pid: 7, pgid: 42, zombie: true },
        { pid: 8, pgid: 99 }
      ]
    ]
    await expect(shutdownProcessGroupsStillLive(new Set([42]), 0)).resolves.toBe(false)
    table.reads = ['throw']
    await expect(shutdownProcessGroupsStillLive(new Set([42]), 0)).resolves.toBe('unknown')
  })
})
