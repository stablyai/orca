import { describe, expect, it } from 'vitest'
import { resolvePrActionAvailability } from './pr-actions-state'

describe('resolvePrActionAvailability', () => {
  it('merged: only unlink', () => {
    expect(resolvePrActionAvailability('merged')).toEqual({
      canMerge: false,
      canAutoMerge: false,
      canClose: false,
      canReopen: false,
      canUnlink: true
    })
  })

  it('closed: reopen + unlink, no merge', () => {
    const a = resolvePrActionAvailability('closed')
    expect(a.canReopen).toBe(true)
    expect(a.canUnlink).toBe(true)
    expect(a.canMerge).toBe(false)
    expect(a.canClose).toBe(false)
  })

  it('open and draft: merge/auto-merge/close allowed', () => {
    for (const state of ['open', 'draft'] as const) {
      const a = resolvePrActionAvailability(state)
      expect(a.canMerge).toBe(true)
      expect(a.canAutoMerge).toBe(true)
      expect(a.canClose).toBe(true)
      expect(a.canReopen).toBe(false)
    }
  })
})
