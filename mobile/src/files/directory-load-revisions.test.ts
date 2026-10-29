import { describe, expect, it } from 'vitest'
import {
  beginDirectoryLoad,
  createDirectoryLoadRevisions,
  isCurrentDirectoryLoad,
  resetDirectoryLoadRevisions,
  type DirectoryLoadRevisions
} from './directory-load-revisions'

describe('directory-load-revisions', () => {
  it('ignores stale duplicate loads for the same directory and scope', () => {
    const revisions: DirectoryLoadRevisions = createDirectoryLoadRevisions()
    const older = beginDirectoryLoad(revisions, 'host-a:worktree-a', 'src')
    const newer = beginDirectoryLoad(revisions, 'host-a:worktree-a', 'src')

    expect(isCurrentDirectoryLoad(revisions, 'host-a:worktree-a', newer)).toBe(true)
    expect(isCurrentDirectoryLoad(revisions, 'host-a:worktree-a', older)).toBe(false)
  })

  it('ignores loads from an old host/worktree scope', () => {
    const revisions: DirectoryLoadRevisions = createDirectoryLoadRevisions()
    const oldScopeLoad = beginDirectoryLoad(revisions, 'host-a:worktree-a', '')

    expect(isCurrentDirectoryLoad(revisions, 'host-b:worktree-b', oldScopeLoad)).toBe(false)
  })

  it('ignores loads from an old reset generation in the same scope', () => {
    const revisions: DirectoryLoadRevisions = createDirectoryLoadRevisions()
    const oldLoad = beginDirectoryLoad(revisions, 'host-a:worktree-a', '')

    resetDirectoryLoadRevisions(revisions)
    const newLoad = beginDirectoryLoad(revisions, 'host-a:worktree-a', '')

    expect(isCurrentDirectoryLoad(revisions, 'host-a:worktree-a', newLoad)).toBe(true)
    expect(isCurrentDirectoryLoad(revisions, 'host-a:worktree-a', oldLoad)).toBe(false)
  })

  it('tracks directory names that overlap object prototype keys', () => {
    const revisions: DirectoryLoadRevisions = createDirectoryLoadRevisions()
    const load = beginDirectoryLoad(revisions, 'host-a:worktree-a', '__proto__')

    expect(isCurrentDirectoryLoad(revisions, 'host-a:worktree-a', load)).toBe(true)
  })
})
