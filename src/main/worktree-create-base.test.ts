import { describe, expect, it, vi } from 'vitest'
import { resolveWorktreeCreateBase } from './worktree-create-base'

describe('resolveWorktreeCreateBase', () => {
  it('falls back from a stale persisted base to the detected default', async () => {
    const resolveDefaultBaseRef = vi.fn().mockResolvedValue('origin/main')
    const isBaseUsable = vi.fn().mockResolvedValue(false)

    await expect(
      resolveWorktreeCreateBase({
        repoWorktreeBaseRef: 'origin/master',
        resolveDefaultBaseRef,
        isBaseUsable
      })
    ).resolves.toBe('origin/main')

    expect(resolveDefaultBaseRef).toHaveBeenCalledTimes(1)
    expect(isBaseUsable).toHaveBeenCalledWith('origin/master')
  })

  it('returns an explicit base without probing defaults or usability', async () => {
    const resolveDefaultBaseRef = vi.fn()
    const isBaseUsable = vi.fn()

    await expect(
      resolveWorktreeCreateBase({
        requestedBaseBranch: 'origin/master',
        repoWorktreeBaseRef: 'origin/main',
        resolveDefaultBaseRef,
        isBaseUsable
      })
    ).resolves.toBe('origin/master')

    expect(resolveDefaultBaseRef).not.toHaveBeenCalled()
    expect(isBaseUsable).not.toHaveBeenCalled()
  })

  it('keeps a usable persisted base when it is still valid', async () => {
    const resolveDefaultBaseRef = vi.fn().mockResolvedValue('origin/main')
    const isBaseUsable = vi.fn().mockResolvedValue(true)

    await expect(
      resolveWorktreeCreateBase({
        repoWorktreeBaseRef: 'origin/master',
        resolveDefaultBaseRef,
        isBaseUsable
      })
    ).resolves.toBe('origin/master')

    expect(resolveDefaultBaseRef).toHaveBeenCalledTimes(1)
    expect(isBaseUsable).toHaveBeenCalledWith('origin/master')
  })
})
