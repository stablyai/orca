import { afterEach, describe, expect, it } from 'vitest'
import { resolveGitAdmissionTier } from './git-operation-executor'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _resetGitAdmissionForTests,
  _gitAdmissionSnapshotForTests
} from './git-subprocess-admission'
import { worktreeCreateGit, worktreePreparationGit } from '../worktree-create-git-executor'

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

  it.each([false, true])(
    'expires inherited policy after completion (failure: %s)',
    async (fail) => {
      const finishDetached = Promise.withResolvers<void>()
      let detached: Promise<string> | undefined
      const create = worktreeCreateGit.run(async () => {
        detached = finishDetached.promise.then(() => resolveGitAdmissionTier())
        if (fail) {
          throw new Error('create failed')
        }
      })
      await (fail ? expect(create).rejects.toThrow('create failed') : create)
      finishDetached.resolve()
      await expect(detached).resolves.toBe('status')
    }
  )

  it('admits nested commands without priority options while preparation work stays queued', async () => {
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 }))
    const blocker = await acquireGitAdmission({ args: ['status'], cwd: '/repo' })
    const preparation = worktreePreparationGit.run(() =>
      acquireGitAdmission({ args: ['status'], cwd: '/repo' })
    )
    try {
      await worktreeCreateGit.run(async () => {
        const grant = await acquireGitAdmission({ args: ['rev-parse', 'HEAD'], cwd: '/repo' })
        expect(_gitAdmissionSnapshotForTests()).toMatchObject({
          queued: 1,
          budgets: { general: { baseUsed: 1, headroomUsed: 1 } }
        })
        grant.release()
      })
    } finally {
      blocker.release()
      const grant = await preparation
      grant.release()
    }
    expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
  })
})
