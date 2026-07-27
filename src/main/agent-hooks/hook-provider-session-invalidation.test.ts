import { describe, expect, it } from 'vitest'
import { createHookProviderSessionInvalidator } from './hook-provider-session-invalidation'

describe('createHookProviderSessionInvalidator', () => {
  it('names the worktree the first time a pane reports a provider session', () => {
    const collect = createHookProviderSessionInvalidator()

    // A phone already streaming session.tabs is not polled while its stream is
    // healthy, so this transition is the only chance to reach it.
    expect(collect([{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w1' }])).toEqual(['w1'])
  })

  it('stays quiet while the same session keeps being reported', () => {
    const collect = createHookProviderSessionInvalidator()
    const rows = [{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w1' }]
    collect(rows)

    // Hook events fire per tool call; re-projecting the workspace each time would
    // undo the coalescing the tab publish path relies on.
    expect(collect(rows)).toEqual([])
  })

  it('names the worktree when a pane relaunches under a new session', () => {
    const collect = createHookProviderSessionInvalidator()
    collect([{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w1' }])

    expect(collect([{ paneKey: 'tab:leaf', sessionId: 's2', worktreeId: 'w1' }])).toEqual(['w1'])
  })

  it('names the worktree when a pane loses its session entirely', () => {
    const collect = createHookProviderSessionInvalidator()
    collect([{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w1' }])

    // Native chat must stop offering a transcript that is no longer addressable.
    expect(collect([])).toEqual(['w1'])
  })

  it('ignores a session with no worktree to invalidate', () => {
    const collect = createHookProviderSessionInvalidator()

    expect(collect([{ paneKey: 'tab:leaf', sessionId: 's1' }])).toEqual([])
  })
})
