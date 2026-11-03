import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginCardFieldsState } from './plugin-card-fields-state'

afterEach(() => vi.useRealTimers())

describe('plugin card fields state', () => {
  it('coalesces a burst of writes into one push per interval', () => {
    vi.useFakeTimers()
    const state = new PluginCardFieldsState(250)
    const pushes: unknown[] = []
    state.onChanged((fields) => pushes.push(fields))
    for (let i = 0; i < 50; i++) {
      state.set('acme.due', 'rev', 'wt-1', { due: `day ${i}` })
    }
    expect(pushes).toEqual([])
    vi.advanceTimersByTime(250)
    expect(pushes).toEqual([{ 'acme.due': { 'wt-1': { due: 'day 49' } } }])
  })

  it('clears a workspace with null and drops a plugin whose install changed', () => {
    vi.useFakeTimers()
    const state = new PluginCardFieldsState(10)
    state.set('acme.due', 'rev', 'wt-1', { due: 'mon' })
    state.set('acme.due', 'rev', 'wt-2', { due: 'tue' })
    state.set('acme.due', 'rev', 'wt-1', null)
    expect(state.snapshot()).toEqual({ 'acme.due': { 'wt-2': { due: 'tue' } } })
    state.prune(() => 'other-rev')
    expect(state.snapshot()).toEqual({})
  })
})
