import { beforeEach, expect, it, vi } from 'vitest'
import { hasSshProviderContinuations } from '../../../ssh/ssh-provider-continuations'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { registerWorktreeRemovalHandlers } from './register-worktree-removal-handlers'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  execute: vi.fn(),
  resolveRepo: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../observability/instrumentation', () => ({
  withWorktreeSpan: (_options: unknown, operation: () => unknown) => operation()
}))
vi.mock('../../worktree-logic', () => ({
  parseWorktreeId: () => ({ repoId: 'repo', worktreePath: '/work/feature' })
}))
vi.mock('../repo-host-ownership', () => ({ resolveRepoForExecutionHost: mocks.resolveRepo }))
vi.mock('./execute-worktree-removal', () => ({ executeWorktreeRemoval: mocks.execute }))

beforeEach(() => vi.clearAllMocks())

function setup(connectionId?: string, kind = 'git') {
  mocks.resolveRepo.mockReturnValue({ id: 'repo', connectionId, kind })
  const worktreeRemovalsInFlight = new Map()
  registerWorktreeRemovalHandlers({
    store: {},
    worktreeRemovalsInFlight
  } as unknown as WorktreeIpcContext)
  const handler = mocks.handle.mock.calls[0]![1]
  return {
    remove: () => handler({}, { worktreeId: 'repo:/work/feature' }) as Promise<unknown>,
    worktreeRemovalsInFlight
  }
}

it.each(['git', 'folder'])(
  'tracks the full SSH %s removal before invocation and through cleanup',
  async (kind) => {
    const state = setup('target', kind)
    const removed = Promise.withResolvers<void>()
    const cleaned = Promise.withResolvers<void>()
    mocks.execute.mockImplementation(async () => {
      expect(hasSshProviderContinuations('target')).toBe(true)
      await removed.promise
      await cleaned.promise
      return { success: true }
    })
    const first = state.remove()
    const joined = state.remove()
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(hasSshProviderContinuations('elsewhere')).toBe(false)
    removed.resolve()
    await Promise.resolve()
    expect(hasSshProviderContinuations('target')).toBe(true)
    cleaned.resolve()
    await Promise.all([first, joined])
    expect(hasSshProviderContinuations('target')).toBe(false)
    expect(state.worktreeRemovalsInFlight.size).toBe(0)
  }
)

it('retains a failed removal until its underlying operation rejects', async () => {
  const state = setup('target')
  const pending = Promise.withResolvers<void>()
  mocks.execute.mockReturnValue(pending.promise)
  const result = state.remove()
  expect(hasSshProviderContinuations('target')).toBe(true)
  pending.reject(new Error('cleanup failed'))
  await expect(result).rejects.toThrow('cleanup failed')
  expect(hasSshProviderContinuations('target')).toBe(false)
  expect(state.worktreeRemovalsInFlight.size).toBe(0)
})

it('does not register local removal as SSH work', async () => {
  const state = setup()
  const pending = Promise.withResolvers<void>()
  mocks.execute.mockReturnValue(pending.promise)
  const result = state.remove()
  expect(hasSshProviderContinuations('target')).toBe(false)
  pending.resolve()
  await result
})

it('tracks a folder owner expressed only by its unified execution host', async () => {
  const state = setup()
  mocks.resolveRepo.mockReturnValue({ id: 'repo', kind: 'folder', executionHostId: 'ssh:target' })
  const pending = Promise.withResolvers<void>()
  mocks.execute.mockReturnValue(pending.promise)
  const result = state.remove()
  expect(hasSshProviderContinuations('target')).toBe(true)
  pending.resolve()
  await result
  expect(hasSshProviderContinuations('target')).toBe(false)
})
