import { describe, expect, it } from 'vitest'
import {
  DetachablePaneWindowLifecycle,
  InvalidDetachablePaneWindowTransitionError,
  canTransitionDetachablePaneWindow,
  transitionDetachablePaneWindow
} from './detachable-pane-window'

describe('detachable pane window lifecycle', () => {
  it('allows the complete detach and reintegrate path', () => {
    const lifecycle = new DetachablePaneWindowLifecycle()

    expect(lifecycle.transition('transferring')).toBe('transferring')
    expect(lifecycle.transition('detached')).toBe('detached')
    expect(lifecycle.transition('reintegrating')).toBe('reintegrating')
    expect(lifecycle.transition('attached')).toBe('attached')
  })

  it('allows parking a detached pane and later reintegrating it', () => {
    const lifecycle = new DetachablePaneWindowLifecycle('detached')

    expect(lifecycle.transition('parked')).toBe('parked')
    expect(lifecycle.transition('reintegrating')).toBe('reintegrating')
    expect(lifecycle.transition('parked')).toBe('parked')
  })

  it('reports whether a transition is valid without changing state', () => {
    expect(canTransitionDetachablePaneWindow('attached', 'transferring')).toBe(true)
    expect(canTransitionDetachablePaneWindow('attached', 'detached')).toBe(false)
    expect(canTransitionDetachablePaneWindow('detached', 'attached')).toBe(false)
  })

  it('rejects invalid transitions with the source and destination', () => {
    const lifecycle = new DetachablePaneWindowLifecycle()

    expect(() => lifecycle.transition('detached')).toThrowError(
      new InvalidDetachablePaneWindowTransitionError('attached', 'detached')
    )
    expect(lifecycle.state).toBe('attached')
  })

  it('rejects direct helper transitions that skip transfer states', () => {
    expect(() => transitionDetachablePaneWindow('attached', 'parked')).toThrow('attached -> parked')
  })
})
