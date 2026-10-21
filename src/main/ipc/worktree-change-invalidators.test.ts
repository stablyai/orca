import { expect, it } from 'vitest'
import {
  registerWorktreeChangeInvalidator,
  runWorktreeChangeInvalidators
} from './worktree-change-invalidators'

it('retires one worktree invalidator while keeping another active', () => {
  const first: string[] = []
  const second: string[] = []
  const unsubscribeFirst = registerWorktreeChangeInvalidator((repoId) => first.push(repoId))
  const unsubscribeSecond = registerWorktreeChangeInvalidator((repoId) => second.push(repoId))

  try {
    runWorktreeChangeInvalidators('repo-1')
    expect(first).toEqual(['repo-1'])
    expect(second).toEqual(['repo-1'])

    unsubscribeFirst()
    runWorktreeChangeInvalidators('repo-2')
    expect(first).toEqual(['repo-1'])
    expect(second).toEqual(['repo-1', 'repo-2'])
  } finally {
    unsubscribeFirst()
    unsubscribeSecond()
  }
})
