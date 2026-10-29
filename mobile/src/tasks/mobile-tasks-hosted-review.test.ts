import { describe, expect, it, vi } from 'vitest'
import { getGitHubMergeLabel } from './mobile-tasks-hosted-review'
import type { GitHubWorkItem } from './mobile-tasks-provider-detail-types'

vi.mock('./mobile-tasks-item-mapping', () => ({ projectRowType: vi.fn() }))

const item: GitHubWorkItem = {
  id: 'pr:30140',
  type: 'pr',
  number: 30140,
  title: 'Page GitHub tasks by number',
  state: 'merged',
  url: 'https://github.com/stablyai/orca/pull/30140',
  labels: [],
  updatedAt: '2026-10-16T00:00:00Z',
  author: null,
  repoId: 'orca',
  repoName: 'orca'
}

describe('mobile Tasks GitHub merge label', () => {
  it.each(['merged', 'closed'] as const)('uses %s state without merge enrichment', (state) => {
    expect(getGitHubMergeLabel({ ...item, state })).toBe(state === 'merged' ? 'Merged' : 'Closed')
  })

  it('hides the merge label for open list rows without merge enrichment', () => {
    expect(getGitHubMergeLabel({ ...item, state: 'open' })).toBeNull()
  })
})
