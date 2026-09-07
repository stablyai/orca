import { describe, expect, it } from 'vitest'
import { createHookProviderSessionInvalidator } from './hook-provider-session-invalidation'

describe('createHookProviderSessionInvalidator', () => {
  it('names the worktree the first time a pane reports a provider session', () => {
    const collect = createHookProviderSessionInvalidator()

    expect(collect([{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w1' }])).toEqual(['w1'])
  })

  it('stays quiet while the same session keeps being reported', () => {
    const collect = createHookProviderSessionInvalidator()
    const rows = [{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w1' }]
    collect(rows)

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

    expect(collect([])).toEqual(['w1'])
  })

  it('names both worktrees when a pane moves without changing session', () => {
    const collect = createHookProviderSessionInvalidator()
    collect([{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w1' }])

    expect(collect([{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w2' }])).toEqual([
      'w1',
      'w2'
    ])
  })

  it('invalidates when Pi keeps its session id but changes transcript path', () => {
    const collect = createHookProviderSessionInvalidator()
    collect([
      { paneKey: 'tab:leaf', sessionId: 's1', transcriptPath: '/pi/a.jsonl', worktreeId: 'w1' }
    ])

    expect(
      collect([
        { paneKey: 'tab:leaf', sessionId: 's1', transcriptPath: '/pi/b.jsonl', worktreeId: 'w1' }
      ])
    ).toEqual(['w1'])
  })

  it('retains the known worktree when a later hook omits it', () => {
    const collect = createHookProviderSessionInvalidator()
    collect([{ paneKey: 'tab:leaf', sessionId: 's1', worktreeId: 'w1' }])

    expect(collect([{ paneKey: 'tab:leaf', sessionId: 's2' }])).toEqual(['w1'])
  })

  it('ignores a session with no worktree to invalidate', () => {
    const collect = createHookProviderSessionInvalidator()

    expect(collect([{ paneKey: 'tab:leaf', sessionId: 's1' }])).toEqual([])
  })
})
