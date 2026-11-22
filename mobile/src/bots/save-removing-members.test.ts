import { describe, expect, it, vi } from 'vitest'
import { saveRemovingMembers } from './bot-sheet-operations'

describe('saveRemovingMembers', () => {
  it('removes each person with its own delta, then saves the update', async () => {
    const save = vi.fn(async () => true)
    const ok = await saveRemovingMembers(
      save,
      [
        { id: 'U1', name: 'Ann', source: 'github', workspaceId: '77' },
        { id: 'U2', name: 'Bo', source: 'github', workspaceId: '77' }
      ],
      { github: null }
    )
    expect(ok).toBe(true)
    expect(save.mock.calls).toEqual([
      [{ removeMember: { id: 'U1', source: 'github', workspaceId: '77' } }],
      [{ removeMember: { id: 'U2', source: 'github', workspaceId: '77' } }],
      [{ github: null }]
    ])
  })

  it('stops without saving the update when a removal fails', async () => {
    const save = vi.fn(async () => false)
    const ok = await saveRemovingMembers(
      save,
      [{ id: 'U1', name: 'Ann', source: 'linear', workspaceId: 'w' }],
      { linear: null }
    )
    expect(ok).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
