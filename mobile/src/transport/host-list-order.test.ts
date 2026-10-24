import { describe, expect, it } from 'vitest'
import { orderHostsByIds } from './host-list-order'

describe('saved desktop order', () => {
  it('reorders identities while retaining the latest metadata objects', () => {
    const first = { id: 'first', lastConnected: 500, name: 'Updated' }
    const second = { id: 'second', lastConnected: 1, name: 'Offline' }
    const current = [first, second]
    const ordered = orderHostsByIds(current, ['second', 'first'])
    expect(ordered).toEqual([second, first])
    expect(ordered[1]).toBe(first)
    expect(current).toEqual([first, second])
  })

  it('ignores removed and duplicate ids, and appends new desktops in stored order', () => {
    const current = [{ id: 'a' }, { id: 'new-1' }, { id: 'b' }, { id: 'new-2' }]
    expect(orderHostsByIds(current, ['removed', 'b', 'b', 'a']).map((host) => host.id)).toEqual([
      'b',
      'a',
      'new-1',
      'new-2'
    ])
  })

  it('keeps all existing desktops when the requested order is empty or entirely stale', () => {
    const current = [{ id: 'a' }, { id: 'b' }]
    expect(orderHostsByIds(current, [])).toEqual(current)
    expect(orderHostsByIds(current, ['removed'])).toEqual(current)
  })
})
