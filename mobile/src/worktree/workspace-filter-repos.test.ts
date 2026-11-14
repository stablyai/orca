import { describe, expect, it } from 'vitest'
import { buildFilterRepos } from './workspace-filter-repos'

describe('the repo filter', () => {
  it("lists each host's same-named repo separately, by id, as the desktop's filter does", () => {
    const repos = buildFilterRepos(
      [
        { id: 'local-orca', displayName: 'orca', path: '/Users/me/orca', badgeColor: '#111111' },
        {
          id: 'm4-orca',
          displayName: 'orca',
          path: '/Users/m4air/orca/orca',
          executionHostId: 'runtime:m4air'
        },
        { id: 'assets', displayName: 'design-assets', path: '/Users/me/design-assets' },
        {
          id: 'local-orca',
          displayName: 'orca',
          path: '/srv/orca',
          executionHostId: 'runtime:other'
        }
      ],
      []
    )

    expect(repos.map(({ key, id, name }) => ({ key, id, name }))).toEqual([
      { key: 'local|local-orca', id: 'local-orca', name: 'orca' },
      { key: 'runtime:m4air|m4-orca', id: 'm4-orca', name: 'orca' },
      { key: 'local|assets', id: 'assets', name: 'design-assets' },
      { key: 'runtime:other|local-orca', id: 'local-orca', name: 'orca' }
    ])
    expect(repos[0]?.color).toBe('#111111')
  })
})
