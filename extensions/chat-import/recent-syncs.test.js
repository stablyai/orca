import { describe, expect, it } from 'vitest'
import { pushRecentSync, topRecentSyncs } from './recent-syncs.js'
describe('pushRecentSync', () => {
  it('prepends and caps to the ring size', () => {
    let l = []
    for (let i = 0; i < 35; i++)
      l = pushRecentSync(
        l,
        { id: 'id' + i, title: 't' + i, source: 'CHATGPT', date: '2026-07-0' + (i % 9) },
        30
      )
    expect(l.length).toBe(30)
    expect(l[0].title).toBe('t34')
  })
  it('dedups by (source, id), not title — a renamed conversation replaces its old entry in place', () => {
    const l = [
      { id: 'abc', title: 'New chat', source: 'CHATGPT', date: '2026-07-01' },
      { id: 'xyz', title: 'Other chat', source: 'CHATGPT', date: '2026-07-02' }
    ]
    const next = pushRecentSync(
      l,
      { id: 'abc', title: 'Renamed chat', source: 'CHATGPT', date: '2026-07-03' },
      30
    )
    // 같은 (source, id)의 옛 항목은 사라지고 새 항목(바뀐 제목)으로 교체된다 — 길이 그대로.
    expect(next.length).toBe(2)
    expect(next.filter((e) => e.id === 'abc').length).toBe(1)
    expect(next[0]).toEqual({
      id: 'abc',
      title: 'Renamed chat',
      source: 'CHATGPT',
      date: '2026-07-03'
    })
    expect(next.find((e) => e.id === 'xyz')?.title).toBe('Other chat')
  })
  it('does not dedup two different conversations that merely share a title (e.g. both "New chat")', () => {
    const l = [{ id: 'a1', title: 'New chat', source: 'CHATGPT', date: '2026-07-01' }]
    const next = pushRecentSync(
      l,
      { id: 'a2', title: 'New chat', source: 'CHATGPT', date: '2026-07-02' },
      30
    )
    expect(next.length).toBe(2)
  })
})
describe('topRecentSyncs', () => {
  it('returns the n most recent by date desc', () => {
    const l = [
      { id: '1', title: 'a', source: 'X', date: '2026-07-01' },
      { id: '2', title: 'b', source: 'X', date: '2026-07-05' },
      { id: '3', title: 'c', source: 'X', date: '2026-07-03' }
    ]
    expect(topRecentSyncs(l, 2).map((e) => e.title)).toEqual(['b', 'c'])
  })
})
