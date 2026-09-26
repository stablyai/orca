import { describe, expect, it, vi } from 'vitest'
import { WorktreeDeepLinkState } from './worktree-deep-link-state'

describe('WorktreeDeepLinkState', () => {
  it('queues a startup worktree deep link until the renderer consumes it once', () => {
    const state = new WorktreeDeepLinkState()

    expect(state.capture(['orca', 'orca://worktree/create?repo=my-project&name=feat-voice'])).toBe(
      true
    )
    expect(state.consume()).toEqual({
      type: 'worktree-create',
      repo: 'my-project',
      name: 'feat-voice'
    })
    expect(state.consume()).toBeNull()
  })

  it('publishes a later deep link intent and keeps it for renderer recovery', () => {
    const state = new WorktreeDeepLinkState()
    const publish = vi.fn()

    state.capture(['orca', 'orca://worktree/create?name=first'])
    expect(
      state.capture(['orca', 'orca://worktree/create?repo=demo-engine&name=second'], publish)
    ).toBe(true)

    expect(publish).toHaveBeenCalledWith({
      type: 'worktree-create',
      repo: 'demo-engine',
      name: 'second'
    })
    expect(state.consume()).toEqual({
      type: 'worktree-create',
      repo: 'demo-engine',
      name: 'second'
    })
  })

  it('clears pending link when publish confirms live delivery', () => {
    const state = new WorktreeDeepLinkState()
    const publish = vi.fn().mockReturnValue(true)

    expect(
      state.capture(['orca', 'orca://worktree/create?name=Live&repo=my-project'], publish)
    ).toBe(true)

    expect(publish).toHaveBeenCalledWith({
      type: 'worktree-create',
      name: 'Live',
      repo: 'my-project'
    })
    expect(state.consume()).toBeNull()
  })

  it('ignores untrusted URLs without replacing a pending intent', () => {
    const state = new WorktreeDeepLinkState()
    state.capture(['orca', 'orca://worktree/create?name=safe'])

    expect(state.capture(['orca', 'https://attacker.test/worktree/create?name=evil'])).toBe(false)
    expect(state.consume()).toEqual({
      type: 'worktree-create',
      name: 'safe'
    })
  })
})
