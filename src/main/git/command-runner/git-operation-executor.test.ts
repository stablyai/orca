import { afterEach, describe, expect, it } from 'vitest'
import { resolveGitAdmissionTier } from './git-operation-executor'
import { _resetGitAdmissionForTests } from './git-subprocess-admission'

import {
  worktreeCreateGit,
  worktreePreparationGit
} from '../worktrees/creation/worktree-create-git-executor'

afterEach(() => _resetGitAdmissionForTests())

describe('Git operation execution policy', () => {
  it('isolates concurrent callers and restores the create policy after nested work', async () => {
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const create = worktreeCreateGit.run(async () => {
      expect(resolveGitAdmissionTier()).toBe('interactive')
      await worktreePreparationGit.run(async () => {
        await Promise.resolve()
        expect(resolveGitAdmissionTier()).toBe('status')
      })
      entered.resolve()
      await finish.promise
      expect(resolveGitAdmissionTier()).toBe('interactive')
      expect(resolveGitAdmissionTier('background')).toBe('background')
    })
    await entered.promise
    expect(resolveGitAdmissionTier()).toBe('status')
    finish.resolve()
    await create
    expect(resolveGitAdmissionTier()).toBe('status')
  })
})
