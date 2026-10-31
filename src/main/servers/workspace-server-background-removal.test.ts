import { expect, it, vi } from 'vitest'
import '../runtime/orca-runtime-test-mocks.spec'
import '../runtime/orca-runtime-test-lifecycle.spec'
import { removeWorktree } from '../runtime/orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, deferred } from '../runtime/orca-runtime-test-fixtures.spec'
import { createWorktreeRemovalRuntime } from '../runtime/orca-runtime-test-scenario-builders.spec'
import { _settlePendingWorktreeRemovalsForTests } from '../worktree-background-removal'

it.each(['success', 'failure'] as const)(
  'fences new server starts after acceptance until background removal %s settles',
  async (outcome) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = createWorktreeRemovalRuntime()
    const started = deferred<void>()
    const finish = deferred<void>()
    vi.mocked(removeWorktree).mockImplementation(async () => {
      started.resolve()
      await finish.promise
      if (outcome === 'failure') {
        throw new Error('expected delete failure')
      }
      return {}
    })
    try {
      const accepted = runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
        waitForBackgroundRemoval: false
      })
      await started.promise
      await expect(accepted).resolves.toEqual({ removing: true })
      const during = runtime.workspaceServers.beginStart()
      try {
        expect(() => during.validate(TEST_WORKTREE_ID)).toThrow('removed')
      } finally {
        during.release()
      }
    } finally {
      finish.resolve()
      await _settlePendingWorktreeRemovalsForTests()
    }
    const after = runtime.workspaceServers.beginStart()
    try {
      expect(() => after.validate(TEST_WORKTREE_ID)).not.toThrow()
    } finally {
      after.release()
    }
  }
)

it('keeps a waiting caller fenced until deletion finishes', async () => {
  const runtime = createWorktreeRemovalRuntime()
  const started = deferred<void>()
  const finish = deferred<void>()
  vi.mocked(removeWorktree).mockImplementation(async () => {
    started.resolve()
    await finish.promise
    return {}
  })
  const removal = runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
    waitForBackgroundRemoval: true
  })
  try {
    await started.promise
    const during = runtime.workspaceServers.beginStart()
    try {
      expect(() => during.validate(TEST_WORKTREE_ID)).toThrow('removed')
    } finally {
      during.release()
    }
  } finally {
    finish.resolve()
    await expect(removal).resolves.toEqual({})
  }
})

it('only explicit Force Delete may waive unverified managed stop during real runtime removal', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const runtime = createWorktreeRemovalRuntime()
  vi.spyOn(runtime.workspaceServers, 'stopWorktree').mockRejectedValue(
    new Error('server termination unverified')
  )
  await expect(
    runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: true,
      waitForBackgroundRemoval: true
    })
  ).rejects.toThrow('server termination unverified')
  expect(removeWorktree).not.toHaveBeenCalled()
  await expect(
    runtime.removeManagedWorktree(TEST_WORKTREE_ID, {
      force: true,
      allowUnverifiedPtyStop: true,
      waitForBackgroundRemoval: true
    })
  ).resolves.toEqual({})
  expect(removeWorktree).toHaveBeenCalledOnce()
})
