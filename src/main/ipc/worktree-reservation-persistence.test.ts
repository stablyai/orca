import { describe, expect, it, vi } from 'vitest'
import { persistCreatedWorktreeOrRollback } from './worktree-reservation-persistence'

describe('reservation-bearing worktree metadata persistence', () => {
  it('does not touch the provider when metadata commits', async () => {
    const rollback = vi.fn(async () => undefined)
    await expect(
      persistCreatedWorktreeOrRollback({
        resourcePath: '/repo/worktree',
        persist: () => 'committed',
        rollback
      })
    ).resolves.toBe('committed')
    expect(rollback).not.toHaveBeenCalled()
  })

  it('rolls back the provider resource before reporting persistence failure', async () => {
    const rollback = vi.fn(async () => undefined)
    await expect(
      persistCreatedWorktreeOrRollback({
        resourcePath: '/repo/worktree',
        persist: () => {
          throw new Error('metadata_failed')
        },
        rollback
      })
    ).rejects.toThrow('metadata_failed')
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('reports both failures when rollback cannot prove the resource was removed', async () => {
    await expect(
      persistCreatedWorktreeOrRollback({
        resourcePath: '/repo/worktree',
        persist: () => {
          throw new Error('metadata_failed')
        },
        rollback: async () => {
          throw new Error('rollback_failed')
        }
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining('rollback failed'),
      errors: [expect.any(Error), expect.any(Error)]
    })
  })
})
