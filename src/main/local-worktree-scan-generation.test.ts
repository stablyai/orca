import { beforeEach, describe, expect, it } from 'vitest'
import {
  getLocalWorktreeScanGeneration,
  getLocalWorktreeScanGenerationCountForTests,
  isLocalWorktreeScanGenerationCurrent,
  MAX_LOCAL_WORKTREE_SCAN_GENERATIONS,
  resetLocalWorktreeScanGenerationsForTests
} from './local-worktree-scan-generation'

describe('local worktree scan generations', () => {
  beforeEach(() => {
    resetLocalWorktreeScanGenerationsForTests()
  })

  it('retains every entry while the derived eviction count is below zero', () => {
    const ids = ['repo-a', 'repo-b', 'repo-c']
    const generations = ids.map((id) => getLocalWorktreeScanGeneration(id))

    expect(getLocalWorktreeScanGenerationCountForTests()).toBe(ids.length)
    expect(ids.map((id) => getLocalWorktreeScanGeneration(id))).toEqual(generations)
  })

  it('bounds unique repository churn and evicts the least recently used id', () => {
    const generations = new Map<string, number>()
    for (let index = 0; index < MAX_LOCAL_WORKTREE_SCAN_GENERATIONS; index += 1) {
      const id = `repo-${index}`
      generations.set(id, getLocalWorktreeScanGeneration(id))
    }

    // Refresh repo-0 so repo-1, not the hot entry, is the next eviction candidate.
    expect(getLocalWorktreeScanGeneration('repo-0')).toBe(generations.get('repo-0'))
    getLocalWorktreeScanGeneration('repo-overflow')

    expect(getLocalWorktreeScanGenerationCountForTests()).toBe(MAX_LOCAL_WORKTREE_SCAN_GENERATIONS)
    expect(getLocalWorktreeScanGeneration('repo-0')).toBe(generations.get('repo-0'))
    expect(getLocalWorktreeScanGeneration('repo-1')).not.toBe(generations.get('repo-1'))
  })

  it('rejects an old generation after its repository id is evicted', () => {
    const staleGeneration = getLocalWorktreeScanGeneration('stale-repo')
    for (let index = 0; index < MAX_LOCAL_WORKTREE_SCAN_GENERATIONS; index += 1) {
      getLocalWorktreeScanGeneration(`repo-${index}`)
    }

    expect(isLocalWorktreeScanGenerationCurrent('stale-repo', staleGeneration)).toBe(false)
    expect(getLocalWorktreeScanGenerationCountForTests()).toBe(MAX_LOCAL_WORKTREE_SCAN_GENERATIONS)
  })
})
