import { describe, expect, it } from 'vitest'
import { resolveMobilePrMergeMethod, resolvePrActionAvailability } from './pr-actions-state'

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

describe('resolveMobilePrMergeMethod', () => {
  it('uses squash when repository settings are unavailable', () => {
    expect(resolveMobilePrMergeMethod(undefined)).toBe('squash')
  })

  it('uses the repository default when it is allowed', () => {
    expect(
      resolveMobilePrMergeMethod({
        defaultMethod: 'rebase',
        allowedMethods: { merge: false, squash: true, rebase: true }
      })
    ).toBe('rebase')
  })

  it('falls back to an allowed method when the default is disabled', () => {
    expect(
      resolveMobilePrMergeMethod({
        defaultMethod: 'rebase',
        allowedMethods: { merge: false, squash: true, rebase: false }
      })
    ).toBe('squash')
  })
})
