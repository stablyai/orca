import { beforeEach, expect, it, vi } from 'vitest'
import type * as PreparationLock from './worktree-preparation-lock'

const gitExec = vi.hoisted(() => vi.fn())
vi.mock('../../command-runner/git-exec-file', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  gitExecFileAsync: gitExec
}))
vi.mock('./checkout-workers-git-args', () => ({ checkoutWorkersGitArgs: async () => [] }))
vi.mock('./worktree-preparation-lock', async (original) => ({
  ...(await original<typeof PreparationLock>()),
  verifyWorktreePreparationLock: async () => '/owned-lock',
  verifyWorktreePreparationLockAtPath: async () => {},
  unlockWorktreePreparationAtPath: async () => {}
}))

import { addWorktree } from './worktree-add'
import { finalizePreparedWorktree } from './worktree-create-preparation'
import { getLocalBaseRefUpdateSuggestionForWorktreeCreate } from './worktree-base-refresh'
import {
  invalidateGitReadCaches,
  invalidateGitStatusReads
} from '../../source-control/git-read-cache-invalidation'
import { beginGitRefMutation } from '../../refs/git-ref-change-signal'
import { createGitOperationExecutor } from '../../command-runner/admission/git-operation-executor'
import { registerWorktreeSuiteHooks } from '../testing/worktree-test-harness'

registerWorktreeSuiteHooks()

beforeEach(() => {
  invalidateGitReadCaches()
  gitExec.mockReset()
})

function fixture() {
  const started = Promise.withResolvers<void>()
  const status = Promise.withResolvers<{ stdout: string }>()
  const scans = { lists: 0, statuses: 0 }
  const statusWaiters: (() => void)[] = []
  gitExec.mockImplementation(async (args: string[]) => {
    if (args[0] === 'rev-parse') {
      return { stdout: args.at(-1) === 'refs/heads/main^{commit}' ? 'local-tip' : 'remote-tip' }
    }
    if (args[0] === 'rev-list') {
      return { stdout: '0\t3\n' }
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      scans.lists++
      return { stdout: 'worktree /repo\nHEAD local-tip\nbranch refs/heads/main\n' }
    }
    if (args.includes('status')) {
      scans.statuses++
      started.resolve()
      statusWaiters.shift()?.()
      return status.promise
    }
    return { stdout: '' }
  })
  return {
    started: started.promise,
    status,
    scans,
    nextStatus: () => new Promise<void>((resolve) => statusWaiters.push(resolve))
  }
}

const suggestion = () =>
  getLocalBaseRefUpdateSuggestionForWorktreeCreate(
    '/repo',
    'origin/main',
    'refs/remotes/origin/main'
  )

it.each([
  { route: 'direct', consumers: 6 },
  { route: 'direct', consumers: 60 },
  { route: 'prepared', consumers: 6 },
  { route: 'prepared', consumers: 60 }
])(
  'bounds base-owner scans for $consumers overlapping $route creates',
  async ({ route, consumers }) => {
    const f = fixture()
    const creates = Array.from({ length: consumers }, (_, i) =>
      route === 'direct'
        ? addWorktree('/repo', `/final-${i}`, `feature-${i}`, 'origin/main', false, false, {
            suggestLocalBaseRefUpdate: true
          })
        : finalizePreparedWorktree(
            '/repo',
            `/prepared-${i}`,
            `/final-${i}`,
            `feature-${i}`,
            'origin/main',
            false,
            { suggestLocalBaseRefUpdate: true },
            'owner'
          )
    )
    await f.started
    f.status.resolve({ stdout: '' })
    const results = await Promise.all(creates)
    expect(results.map((result) => result.localBaseRefUpdateSuggestion)).toEqual(
      Array.from({ length: consumers }, () => ({
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 3
      }))
    )
    expect(f.scans).toEqual({ lists: 1, statuses: 1 })
  }
)

it.each(['settled', 'tracked edit', 'ref entry', 'ref completion'] as const)(
  'inspects fresh after %s with unchanged tips',
  async (boundary) => {
    const f = fixture()
    const old = suggestion()
    await f.started
    let releaseMutation: (() => void) | undefined
    if (boundary === 'settled') {
      f.status.resolve({ stdout: '' })
      await old
    } else if (boundary === 'tracked edit') {
      invalidateGitStatusReads(['/repo'])
    } else {
      releaseMutation = beginGitRefMutation(null)
      if (boundary === 'ref completion') {
        const nextStatus = f.nextStatus()
        const during = suggestion()
        await nextStatus
        releaseMutation()
        f.status.resolve({ stdout: '' })
        await during
      }
    }
    const previous = gitExec.getMockImplementation()!
    gitExec.mockImplementation((args, options) =>
      args.includes('status')
        ? Promise.resolve({ stdout: ' M tracked-file\n' })
        : previous(args, options)
    )
    await expect(suggestion()).resolves.toBeUndefined()
    f.status.resolve({ stdout: '' })
    await expect(old).resolves.toEqual({ baseRef: 'origin/main', localBranch: 'main', behind: 3 })
    releaseMutation?.()
  }
)

it('keeps inherited admission tiers separate', async () => {
  const f = fixture()
  const background = createGitOperationExecutor('background').run(suggestion)
  await f.started
  const interactive = createGitOperationExecutor('interactive').run(suggestion)
  f.status.resolve({ stdout: '' })
  await Promise.all([background, interactive])
  expect(f.scans).toEqual({ lists: 2, statuses: 2 })
})
