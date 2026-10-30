import { describe, expect, it } from 'vitest'
import { resolveMobileHistoryScreenView } from './mobile-history-screen-state'
const row = { key: 'abc123' }

describe('resolveMobileHistoryScreenView', () => {
  it('shows waiting (not an endless spinner) when disconnected with nothing loaded', () => {
    // Offline cold loads cannot run; show Retry instead of an endless spinner.
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
