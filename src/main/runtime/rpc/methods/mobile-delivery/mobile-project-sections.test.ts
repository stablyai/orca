import { describe, expect, it } from 'vitest'
import { MOBILE_PROJECT_SECTIONS_METHOD } from '../../../../../shared/sidebar-list/catalog/mobile-project-sections-contract'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  partialRuntimeStore,
  storeProjectGroup,
  storeRepo
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import { publishHeadlessRuntimeGraph } from '../../../session-graph/headless-runtime-graph'
import { RpcDispatcher } from '../../dispatcher'
import { MOBILE_PROJECT_SECTIONS_METHODS } from './mobile-project-sections'

describe('mobileRelay.projectSections', () => {
  it("answers a headless host's project groups, which no window publishes", async () => {
    const repos = [
      storeRepo({ id: 'api', path: '/srv/api', projectGroupId: 'work', projectGroupOrder: 0 }),
      storeRepo({ id: 'notes', path: '/srv/notes' })
    ]
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => repos,
        getProjectGroups: () => [storeProjectGroup({ id: 'work', name: 'Work' })]
      })
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
