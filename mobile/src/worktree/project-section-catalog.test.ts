import { describe, expect, it } from 'vitest'
import { buildProjectSectionCatalog } from './project-section-catalog'
import type { ServedProjectSections } from './project-sections-operations'

const uploaded = { type: 'image', src: 'data:image/png;base64,AAAA' }

type ServedRepo = ServedProjectSections['repos'][number]

function repo(
  id: string,
  executionHostId?: ServedRepo['executionHostId'],
  repoIcon?: unknown
): ServedRepo {
  return {
    id,
    displayName: 'orca',
    path: `/repos/${id}`,
    badgeColor: undefined,
    addedAt: undefined,
    connectionId: undefined,
    executionHostId,
    projectGroupId: undefined,
    projectGroupOrder: undefined,
    ...(repoIcon ? { repoIcon } : {})
  }
}

describe('buildProjectSectionCatalog', () => {
  it("restores an uploaded icon from the desktop's repo.list only for the same host's repo", () => {
    const served: ServedProjectSections = {
      repos: [repo('r1'), repo('r1', 'runtime:m4air')],
      projects: [],
      setups: [],
      projectOrderBy: 'manual',
      projectGroups: undefined
    }
    const catalog = buildProjectSectionCatalog(
      served,
      [repo('r1', undefined, uploaded)],
      null,
      'manual'
    )
    expect(catalog.repos.map((entry) => entry.repoIcon)).toEqual([uploaded, undefined])
  })

  it('supplements unrepresented repos from desktop repos when served omits them', () => {
    const served: ServedProjectSections = {
      repos: [repo('r1')],
      projects: [{ id: 'repo:r1', displayName: 'orca' }],
      setups: [
        {
          id: 'r1',
          projectId: 'repo:r1',
          hostId: 'local',
          repoId: 'r1',
          path: '/repos/r1',
          displayName: 'orca',
          setupMethod: 'legacy-repo'
        }
      ],
      projectOrderBy: 'manual',
      projectGroups: undefined
    }
    const newLocalRepo = repo('slides-benchmark')
    const catalog = buildProjectSectionCatalog(served, [repo('r1'), newLocalRepo], null, 'manual')

    expect(catalog.grouping?.projectHostSetups).toHaveLength(2)
    expect(catalog.grouping?.projectHostSetups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoId: 'r1' }),
        expect.objectContaining({ repoId: 'slides-benchmark', projectId: 'repo:slides-benchmark' })
      ])
    )
  })
})
