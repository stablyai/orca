import { describe, expect, it } from 'vitest'
import { ProgramStatusFacetStore } from './facet-store'

const facet = (progress: number, observedAt = 1) => ({
  state: 'working' as const,
  progress,
  observedAt
})

describe('ProgramStatusFacetStore', () => {
  it('reports only content changes, not redelivery', () => {
    const store = new ProgramStatusFacetStore()
    expect(store.set('p', facet(40))).toBe(true)
    expect(store.set('p', facet(40, 99))).toBe(false)
    expect(store.set('p', facet(41))).toBe(true)
    expect(store.set('p', null)).toBe(true)
    expect(store.set('p', null)).toBe(false)
  })

  it('stitches a copy and never mutates the stored row', () => {
    const store = new ProgramStatusFacetStore()
    const row = { paneKey: 'p', state: 'working' }
    store.set('p', facet(10))
    const stitched = store.stitch(row)
    expect(stitched).toEqual({ ...row, programStatus: facet(10) })
    expect(row).toEqual({ paneKey: 'p', state: 'working' })
    store.delete('p')
    expect(store.stitch(stitched)).toEqual(row)
  })

  it('moves a facet with its pane', () => {
    const store = new ProgramStatusFacetStore()
    store.set('old', facet(5))
    store.move('old', 'new')
    expect(store.get('old')).toBeUndefined()
    expect(store.get('new')?.progress).toBe(5)
  })
})
