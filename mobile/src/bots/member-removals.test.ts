import { describe, expect, it } from 'vitest'
import { memberRemovals } from './bot-sheet-operations'

describe('memberRemovals', () => {
  it('names each person to remove, so the host applies it to its own roster', () => {
    expect(
      memberRemovals([
        { id: 'U1', name: 'Ann', source: 'github', workspaceId: '77' },
        { id: 'U2', name: 'Bo', source: 'linear' }
      ])
    ).toEqual([
      { id: 'U1', source: 'github', workspaceId: '77' },
      { id: 'U2', source: 'linear' }
    ])
  })
})
