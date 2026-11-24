import { describe, expect, it } from 'vitest'
import {
  formatWorktreeDeepLink,
  openWorktreeDeepLink,
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

  it('activates the worktree the selector resolves to', async () => {
    const activated: string[] = []
    const runtime = {
      activateManagedWorktree: async (selector: string) => {
        activated.push(selector)
      }
    }
    expect(await openWorktreeDeepLink({ selector: 'branch:fix-login' }, runtime)).toBe(true)
    expect(activated).toEqual(['branch:fix-login'])
  })

  it('reports false for a selector that matches no worktree', async () => {
    const runtime = {
      activateManagedWorktree: async () => {
        throw new Error('selector_not_found')
      }
    }
    expect(await openWorktreeDeepLink({ selector: 'branch:gone' }, runtime)).toBe(false)
  })
})
