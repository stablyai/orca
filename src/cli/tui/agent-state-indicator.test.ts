import { describe, expect, it } from 'vitest'
import {
  IDLE_HOLD_CAP_MS,
  indicatorFor,
  initialDebounceState,
  reconcileIndicator,
  worktreeIndicatorKind,
  type StatusIndicatorKind
} from './agent-state-indicator'

describe('worktreeIndicatorKind', () => {
  it('maps each agent state to the documented indicator', () => {
    expect(worktreeIndicatorKind('inactive', [{ state: 'working' }])).toBe('working')
    expect(worktreeIndicatorKind('inactive', [{ state: 'blocked' }])).toBe('blocked')
    expect(worktreeIndicatorKind('inactive', [{ state: 'waiting' }])).toBe('blocked')
    expect(worktreeIndicatorKind('inactive', [{ state: 'done' }])).toBe('done')
    expect(worktreeIndicatorKind('inactive', [])).toBe('idle')
  })

  it('treats worktree permission status as blocked even with no blocked agent', () => {
    expect(worktreeIndicatorKind('permission', [{ state: 'working' }])).toBe('blocked')
  })

  it('prioritizes blocked over working when both are present', () => {
    expect(worktreeIndicatorKind('working', [{ state: 'working' }, { state: 'blocked' }])).toBe(
      'blocked'
    )
  })

  it('surfaces done from worktree status', () => {
    expect(worktreeIndicatorKind('done', [])).toBe('done')
  })
})

describe('indicatorFor', () => {
  it('gives each kind a distinct glyph so states read without color', () => {
    const glyphs = (['blocked', 'working', 'done', 'idle'] as StatusIndicatorKind[]).map(
      (k) => indicatorFor(k).glyph
    )
    expect(new Set(glyphs).size).toBe(4)
  })

  it('maps kinds to their colors', () => {
    expect(indicatorFor('blocked').color).toBe('red')
    expect(indicatorFor('working').color).toBe('yellow')
    expect(indicatorFor('done').color).toBe('blue')
    expect(indicatorFor('idle').color).toBe('gray')
  })
})

describe('reconcileIndicator (anti-flicker)', () => {
  it('publishes the same kind immediately when unchanged', () => {
    const start = initialDebounceState('working')
    const { published } = reconcileIndicator(start, 'working', 0)
    expect(published).toBe('working')
  })

  it('holds a working→idle transition until confirmed, then publishes idle', () => {
    // First reconcile starts the hold; it then takes `confirmations` more
    // consecutive idle reads to publish.
    let out = reconcileIndicator(initialDebounceState('working'), 'idle', 0, { confirmations: 2 })
    expect(out.published).toBe('working') // hold started
    out = reconcileIndicator(out.state, 'idle', 1, { confirmations: 2 })
    expect(out.published).toBe('working') // 1st confirmation, still held
    out = reconcileIndicator(out.state, 'idle', 2, { confirmations: 2 })
    expect(out.published).toBe('idle') // 2nd confirmation publishes
  })

  it('publishes idle once the hold cap elapses regardless of confirmations', () => {
    const state = initialDebounceState('working')
    const held = reconcileIndicator(state, 'idle', 0)
    expect(held.published).toBe('working')
    const capped = reconcileIndicator(held.state, 'idle', IDLE_HOLD_CAP_MS + 1)
    expect(capped.published).toBe('idle')
  })

  it('does not flicker idle when work resumes mid-hold', () => {
    const state = initialDebounceState('working')
    const held = reconcileIndicator(state, 'idle', 0)
    // work resumes before idle was confirmed → stays working, pending cleared
    const resumed = reconcileIndicator(held.state, 'working', 10)
    expect(resumed.published).toBe('working')
    expect(resumed.state.pendingSince).toBeNull()
  })

  it('publishes blocked immediately (never debounced — the user needs to act)', () => {
    const state = initialDebounceState('working')
    const out = reconcileIndicator(state, 'blocked', 0)
    expect(out.published).toBe('blocked')
  })

  it('publishes working immediately when coming from idle', () => {
    const state = initialDebounceState('idle')
    expect(reconcileIndicator(state, 'working', 0).published).toBe('working')
  })
})
