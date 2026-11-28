import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../../../shared/sidebar-list/catalog/mobile-project-sections-contract'
import type { RuntimeStore } from '../../../construction/runtime-store-contract'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { publishHeadlessRuntimeGraph } from '../../../session-graph/headless-runtime-graph'
import type { SidebarProjectCatalogStore } from '../../../sidebar-inputs/catalog/sidebar-project-catalog'
import { RpcDispatcher } from '../../dispatcher'
import { MOBILE_PROJECT_SECTIONS_METHODS } from './mobile-project-sections'

function repo(fields: Pick<Repo, 'id' | 'path'> & Partial<Repo>): Repo {
  return { displayName: fields.id, badgeColor: '#737373', addedAt: 0, ...fields }
}

const WORK: ProjectGroup = {
  id: 'work',
  name: 'Work',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

function catalogStore(repos: Repo[], projectGroups: ProjectGroup[]): RuntimeStore {
  const store: SidebarProjectCatalogStore = {
    getRepos: () => repos,
    getProjectGroups: () => projectGroups,
    getFolderWorkspaces: () => [],
    getSshTargets: () => [],
    getProjectHostSetups: () => []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the project sections reply reads only the catalog members.
  return store as unknown as RuntimeStore
}

describe('mobileRelay.projectSections', () => {
  it("answers a headless host's project groups, which no window publishes", async () => {
    const runtime = new OrcaRuntimeService(
      catalogStore(
        [
          repo({ id: 'api', path: '/srv/api', projectGroupId: 'work', projectGroupOrder: 0 }),
          repo({ id: 'notes', path: '/srv/notes' })
        ],
        [WORK]
      )
    )
    publishHeadlessRuntimeGraph(runtime)

    const response = await new RpcDispatcher({
      runtime,
      methods: MOBILE_PROJECT_SECTIONS_METHODS
    }).dispatch({ id: 'sections', authToken: 'tok', method: MOBILE_PROJECT_SECTIONS_METHOD })

    expect(response).toMatchObject({
      ok: true,
      result: {
        catalog: {
          repos: [{ id: 'api', projectGroupId: 'work' }, { id: 'notes' }],
          projectGroups: [{ id: 'work', name: 'Work' }]
        }
      }
    })
  })
})
