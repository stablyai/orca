import { describe, expect, it } from 'vitest'
import { WorkspaceCreationRegistry } from './workspace-creation-registry'

describe('WorkspaceCreationRegistry', () => {
  it('lists a creation once opened, names its workspace, and drops it on close', () => {
    const registry = new WorkspaceCreationRegistry()
    const creation = registry.open({ creationId: 'c1', repoId: 'repo-1' })
    expect(registry.snapshot().creations).toEqual({ c1: { repoId: 'repo-1' } })
    const opened = registry.snapshot().revision

    creation.named('repo-1::/wt')
    expect(registry.snapshot().creations).toEqual({
      c1: { repoId: 'repo-1', worktreeId: 'repo-1::/wt' }
    })
    expect(registry.snapshot().revision).toBeGreaterThan(opened)

    creation.close()
    expect(registry.snapshot().creations).toEqual({})
  })

  it('mints an id for a caller that sends none', () => {
    const registry = new WorkspaceCreationRegistry()
    const creation = registry.open({ repoId: 'repo-1' })
    const ids = Object.keys(registry.snapshot().creations)
    expect(ids).toHaveLength(1)
    expect(ids[0]).not.toBe('')
    creation.close()
    expect(registry.snapshot().creations).toEqual({})
  })

  it('leaves a concurrent retry under the same id listed when the first create closes', () => {
    const registry = new WorkspaceCreationRegistry()
    const first = registry.open({ creationId: 'c1', repoId: 'repo-1' })
    const second = registry.open({ creationId: 'c1', repoId: 'repo-1' })

    first.named('repo-1::/stale')
    first.close()
    expect(registry.snapshot().creations).toEqual({ c1: { repoId: 'repo-1' } })

    second.close()
    expect(registry.snapshot().creations).toEqual({})
  })

  it('closes once', () => {
    const registry = new WorkspaceCreationRegistry()
    const creation = registry.open({ creationId: 'c1', repoId: 'repo-1' })
    creation.close()
    const closed = registry.snapshot().revision
    creation.close()
    expect(registry.snapshot().revision).toBe(closed)
  })
})
