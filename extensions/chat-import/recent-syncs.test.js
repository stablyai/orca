import { describe, expect, it } from 'vitest'
import { pushRecentSync, topRecentSyncs } from './recent-syncs.js'
describe('pushRecentSync', () => {
  it('prepends and caps to the ring size', () => {
    let l = []
    for (let i = 0; i < 35; i++)
      l = pushRecentSync(l, { title: 't' + i, source: 'CHATGPT', date: '2026-07-0' + (i % 9) }, 30)
    expect(l.length).toBe(30)
    expect(l[0].title).toBe('t34')
  })
})
describe('topRecentSyncs', () => {
  it('returns the n most recent by date desc', () => {
    const l = [
      { title: 'a', source: 'X', date: '2026-07-01' },
      { title: 'b', source: 'X', date: '2026-07-05' },
      { title: 'c', source: 'X', date: '2026-07-03' }
    ]
    expect(topRecentSyncs(l, 2).map((e) => e.title)).toEqual(['b', 'c'])
  })
})
