import { describe, expect, it } from 'vitest'
import { resolveWorktreeCreateBase } from './worktree-create-base'

describe('resolveWorktreeCreateBase', () => {
  it('returns the default ref a successful lookup finds', async () => {
    await expect(
      resolveWorktreeCreateBase({
        resolveDefaultBaseRef: async () => 'origin/main',
        isBaseUsable: async () => false
      })
    ).resolves.toBe('origin/main')
  })

  it('keeps a usable persisted ref when the lookup fails', async () => {
    // A failed lookup reports through onError, not a throw, so a usable
    // persisted base still wins; only its loss is the create's error.
    let reported: unknown
    const failedLookup = async () => {
      reported = new Error('timed out')
      return null
    }
    await expect(
      resolveWorktreeCreateBase({
        repoWorktreeBaseRef: 'origin/stable',
        resolveDefaultBaseRef: failedLookup,
        isBaseUsable: async (candidate) => candidate === 'origin/stable'
      })
    ).resolves.toBe('origin/stable')
    expect(reported).toBeInstanceOf(Error)
  })

  it('answers null when the lookup failed and nothing else is usable', async () => {
    await expect(
      resolveWorktreeCreateBase({
        repoWorktreeBaseRef: 'origin/stale',
        resolveDefaultBaseRef: async () => null,
        isBaseUsable: async () => false
      })
    ).resolves.toBeNull()
  })
})
