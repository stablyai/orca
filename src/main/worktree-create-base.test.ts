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
  it('notifies advisory checks when keeping a usable persisted base', async () => {
    const onPersistedBaseSelected = vi.fn().mockResolvedValue(undefined)

    await expect(
      resolveWorktreeCreateBase({
        repoWorktreeBaseRef: 'work/stale',
        resolveDefaultBaseRef: vi.fn().mockResolvedValue('origin/main'),
        isBaseUsable: vi.fn().mockResolvedValue(true),
        onPersistedBaseSelected
      })
    ).resolves.toBe('work/stale')

    expect(onPersistedBaseSelected).toHaveBeenCalledWith('work/stale', 'origin/main')
  })

  it('keeps a usable persisted base when an advisory check fails', async () => {
    await expect(
      resolveWorktreeCreateBase({
        repoWorktreeBaseRef: 'work/stale',
        resolveDefaultBaseRef: vi.fn().mockResolvedValue('origin/main'),
        isBaseUsable: vi.fn().mockResolvedValue(true),
        onPersistedBaseSelected: async () => {
          throw new Error('probe failed')
        }
      })
    ).resolves.toBe('work/stale')
  })

  it('does not run advisory checks for an explicit base', async () => {
    const onPersistedBaseSelected = vi.fn()

    await resolveWorktreeCreateBase({
      requestedBaseBranch: 'work/stale',
      repoWorktreeBaseRef: 'origin/main',
      resolveDefaultBaseRef: vi.fn(),
      isBaseUsable: vi.fn(),
      onPersistedBaseSelected
    })

    expect(onPersistedBaseSelected).not.toHaveBeenCalled()
  })
})
