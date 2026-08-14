import { describe, expect, it } from 'vitest'
import {
  admitStructuredOlderPage,
  beginStructuredUserScroll,
  createMobileStructuredPaginationState,
  finishStructuredPaginationMomentum,
  settleStructuredOlderPage
} from './mobile-structured-history-pagination'

describe('mobile structured pagination latch', () => {
  it('requires user intent and ignores programmatic momentum ownership', () => {
    const state = createMobileStructuredPaginationState()
    expect(admitStructuredOlderPage(state)).toBe(false)
    beginStructuredUserScroll(state)
    expect(admitStructuredOlderPage(state)).toBe(true)
    expect(admitStructuredOlderPage(state)).toBe(false)
    settleStructuredOlderPage(state)
    finishStructuredPaginationMomentum(state, false)
    expect(state.phase).toBe('latched')
    expect(admitStructuredOlderPage(state)).toBe(false)
    beginStructuredUserScroll(state)
    expect(admitStructuredOlderPage(state)).toBe(true)
  })

  it('admits a second page after a settled load without a momentum event', () => {
    const state = createMobileStructuredPaginationState()
    beginStructuredUserScroll(state)
    expect(admitStructuredOlderPage(state)).toBe(true)
    settleStructuredOlderPage(state)

    beginStructuredUserScroll(state)
    expect(admitStructuredOlderPage(state)).toBe(true)
  })
})
