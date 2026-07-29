import { describe, expect, it } from 'vitest'
import { resolveMobileHistoryScreenView } from './mobile-history-screen-state'
import type { MobileCommitRow } from './mobile-git-history'

const row: MobileCommitRow = {
  id: 'abc123',
  shortId: 'abc123',
  subject: 'commit',
  author: 'author',
  parentId: null,
  relativeTime: '1m'
}

describe('resolveMobileHistoryScreenView', () => {
  it('shows waiting (not an endless spinner) when disconnected with nothing loaded', () => {
    // Regression (STA-1511): the load effect no-ops while disconnected, so
    // rows stay null forever — the screen must offer a retry, not a spinner.
    expect(resolveMobileHistoryScreenView({ connected: false, rows: null, error: null })).toEqual({
      kind: 'waiting'
    })
  })

  it('spins only while connected and loading', () => {
    expect(resolveMobileHistoryScreenView({ connected: true, rows: null, error: null })).toEqual({
      kind: 'loading'
    })
  })

  it('keeps already-loaded rows visible across a connection drop', () => {
    expect(resolveMobileHistoryScreenView({ connected: false, rows: [row], error: null })).toEqual({
      kind: 'rows',
      rows: [row]
    })
  })

  it('prefers the error state over waiting so failures stay actionable', () => {
    expect(resolveMobileHistoryScreenView({ connected: false, rows: null, error: 'boom' })).toEqual(
      { kind: 'error', message: 'boom' }
    )
  })

  it('distinguishes an empty history from a pending load', () => {
    expect(resolveMobileHistoryScreenView({ connected: true, rows: [], error: null })).toEqual({
      kind: 'empty'
    })
  })
})
