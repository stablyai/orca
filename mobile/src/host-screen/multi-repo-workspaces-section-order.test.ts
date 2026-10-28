import { describe, expect, it } from 'vitest'
import type { Section } from '../worktree/workspace-list-types'
import { hoistMultiRepoWorkspaceSections } from './multi-repo-workspaces-section-order'

const section = (key: string, extra: Partial<Section> = {}): Section => ({
  key,
  title: key,
  data: [],
  ...extra
})

describe('hoistMultiRepoWorkspaceSections', () => {
  const workspaceKeys = new Set(['workspaces'])
  const hostKeys = new Set(['host'])

  it('keeps a collapsed Workspaces section that has no rows but a count', () => {
    const result = hoistMultiRepoWorkspaceSections(
      [section('host'), section('repo'), section('workspaces', { count: 3 })],
      workspaceKeys,
      hostKeys
    )
    expect(result.map((entry) => entry.key)).toEqual(['host', 'workspaces', 'repo'])
  })

  it('drops a Workspaces section with no rows, no count and no pending creations', () => {
    const result = hoistMultiRepoWorkspaceSections(
      [section('host'), section('workspaces', { count: 0 }), section('repo')],
      workspaceKeys,
      hostKeys
    )
    expect(result.map((entry) => entry.key)).toEqual(['host', 'repo'])
  })

  it('keeps a section that only has pending creations', () => {
    const result = hoistMultiRepoWorkspaceSections(
      [
        section('host'),
        section('workspaces', { pendingCreations: [{ key: 'p', repoName: null }] })
      ],
      workspaceKeys,
      hostKeys
    )
    expect(result.map((entry) => entry.key)).toEqual(['host', 'workspaces'])
  })
})
