import { describe, expect, it } from 'vitest'
import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { assertWorktreeMetaIdentity } from './worktree-meta-identity-guard'

const occupant = { instanceId: 'inst-1', hostId: 'local' } as unknown as WorktreeMeta
const key = canonicalWorktreeIdentity({
  worktreeId: 'repo::/path/w',
  executionHostId: 'local',
  instanceId: 'inst-1'
})

describe('assertWorktreeMetaIdentity', () => {
  it('lets a write through when the occupant carries the pinned identity', () => {
    expect(() => assertWorktreeMetaIdentity(occupant, 'repo::/path/w', key)).not.toThrow()
  })

  // Regression: a checkout replaced at the same path between the renderer's lookup and the
  // main-process write inherited the previous occupant's color.
  it('refuses when the current occupant is a different instance', () => {
    const replacement = { instanceId: 'inst-2', hostId: 'local' } as unknown as WorktreeMeta
    expect(() => assertWorktreeMetaIdentity(replacement, 'repo::/path/w', key)).toThrow(
      /identity changed/
    )
  })

  it('refuses when nothing occupies the locator any more', () => {
    expect(() => assertWorktreeMetaIdentity(undefined, 'repo::/path/w', key)).toThrow()
  })

  it('refuses when the occupant predates identities', () => {
    const legacy = { instanceId: undefined, hostId: undefined } as unknown as WorktreeMeta
    expect(() => assertWorktreeMetaIdentity(legacy, 'repo::/path/w', key)).toThrow()
  })

  it('is a no-op for writes that pin nothing', () => {
    expect(() => assertWorktreeMetaIdentity(undefined, 'repo::/path/w', undefined)).not.toThrow()
  })

  it('survives a folder rename, which changes the locator but not the identity', () => {
    expect(() => assertWorktreeMetaIdentity(occupant, 'repo::/path/renamed', key)).not.toThrow()
  })
})
