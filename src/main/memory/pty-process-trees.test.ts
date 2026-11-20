import { describe, expect, it } from 'vitest'
import { buildProcessIndex, parsePsOutput } from './process-index'
import { claimOrphanedGroup, claimProcessTree } from './pty-process-trees'

describe('agent process trees', () => {
  it('count what the agent backgrounded after init adopted it, and nothing from other groups', () => {
    const index = buildProcessIndex(
      parsePsOutput(
        [
          '100    50   0.0  1000  100', // the agent, leading its own group
          '200     1   0.0  4000  100', // backgrounded by the agent, then orphaned
          '201   200   0.0  2000  100', // its child
          '300     1   0.0  8000  300' // an unrelated daemon
        ].join('\n'),
        false,
        true
      ),
      null,
      'rss'
    )
    const claimed = new Set<number>()

    const rows = [...claimProcessTree(index, 100, claimed), ...claimOrphanedGroup(index, 100, claimed)]

    expect(rows.map((row) => row.pid).sort()).toEqual([100, 200, 201])
  })
})
