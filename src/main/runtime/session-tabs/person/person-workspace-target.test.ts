import { expect, it } from 'vitest'
import { holderOfTabList, tabListOfPty } from './person-workspace-target'

it('joins a held terminal to its teammate list and back, and every other terminal to where it runs', () => {
  const holder = 'teammate:bot%3A1:usr%25mate' as const
  const list = tabListOfPty({ worktreeId: 'folder:home:1', holder })

  expect(list).toBe('person:home%3A1:bot%3A1:usr%25mate')
  expect(holderOfTabList(list)).toEqual({ home: 'folder:home:1', holder })
  expect(tabListOfPty({ worktreeId: 'folder:home:1' })).toBe('folder:home:1')
  // A stamp outside a folder workspace (a worker's worktree) names no list of its own.
  expect(tabListOfPty({ worktreeId: 'repo::/w', holder })).toBe('repo::/w')
  expect(holderOfTabList('repo::/w')).toEqual({ home: 'repo::/w', holder: undefined })
})
