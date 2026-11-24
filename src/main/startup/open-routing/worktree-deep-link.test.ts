import { describe, expect, it } from 'vitest'
import { DeepLinkState } from '../deep-link-state'
import {
  drainWorktreeDeepLink,
  formatWorktreeDeepLink,
  parseWorktreeDeepLink
} from './worktree-deep-link'

describe('worktree deep link', () => {
  it('round-trips a selector with characters that need escaping', () => {
    const url = formatWorktreeDeepLink({ selector: 'path:/Users/me/code/app/.worktrees/a b' })
    expect(url).toBe(
      'orca://worktree?selector=path%3A%2FUsers%2Fme%2Fcode%2Fapp%2F.worktrees%2Fa%20b'
    )
    expect(parseWorktreeDeepLink(url)).toEqual({
      selector: 'path:/Users/me/code/app/.worktrees/a b'
    })
  })

  it('ignores other orca routes and empty selectors', () => {
    expect(parseWorktreeDeepLink('orca://skills/share/abc')).toBeNull()
    expect(parseWorktreeDeepLink('orca://worktree')).toBeNull()
    expect(parseWorktreeDeepLink('orca://worktree?selector=%20')).toBeNull()
  })

  it('holds a link until drained, and a repeat click does not stack', () => {
    const state = new DeepLinkState(() => 0)
    const url = 'orca://worktree?selector=branch%3Afix-login'
    expect(state.capture([url, url])).toBe(true)
    expect(state.consumeWorktreeLink()).toBe('branch:fix-login')
    expect(state.consumeWorktreeLink()).toBeNull()
  })

  it('focuses the worktree the held selector names once a window can take it', async () => {
    const state = new DeepLinkState(() => 0)
    state.capture(['orca://worktree?selector=branch%3Afix-login'])
    const focused: string[] = []
    let ready = false
    const runtime = {
      canFocusManagedWorktree: () => ready,
      focusManagedWorktree: async (selector: string) => {
        focused.push(selector)
      }
    }
    await drainWorktreeDeepLink(state, runtime)
    expect(focused).toEqual([])
    ready = true
    await drainWorktreeDeepLink(state, runtime)
    expect(focused).toEqual(['branch:fix-login'])
  })

  it('drops a selector that matches no worktree', async () => {
    const state = new DeepLinkState(() => 0)
    state.capture(['orca://worktree?selector=branch%3Agone'])
    const runtime = {
      canFocusManagedWorktree: () => true,
      focusManagedWorktree: async () => {
        throw new Error('selector_not_found')
      }
    }
    await drainWorktreeDeepLink(state, runtime)
    expect(state.consumeWorktreeLink()).toBeNull()
  })
})
