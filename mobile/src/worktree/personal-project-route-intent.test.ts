import { expect, it } from 'vitest'
import { getDefaultUIState } from '../../../src/shared/constants'
import { mutatePersonalProjectOrder } from '../../../src/shared/personal-project-order-writes'
import { RecordProjectOpenParams } from '../../../src/shared/rpc-contract/personal-project-order-params'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { buildMobileProjectSectionCatalog } from '../../../src/shared/mobile-project-sections-contract'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import { recordPersonalProjectRouteIntent } from './personal-project-route-intent'

it.each([null, 'a::/a'])(
  'records Resume only when changing projects from %s, while ordinary mounts and old peers record nothing',
  async (previousWorktreeId) => {
    const repo = { id: 'a', path: '/a', displayName: 'Alpha', badgeColor: '', addedAt: 0 }
    const catalog = buildMobileProjectSectionCatalog(
      [repo],
      projectHostSetupProjectionFromRepos([repo]),
      'recent'
    )
    let ui = getDefaultUIState()
    const calls: string[] = []
    let viewCapabilities = ['ui.personalProjectOrder.v1']
    const runtime = {
      getUIState: () => ui,
      updateUIState: (patch: Partial<typeof ui>) => (ui = { ...ui, ...patch })
    }
    const viewClient = stubRpcClient({
      sendRequest: async (method, params): Promise<RpcResponse> => {
        calls.push(method)
        if (method === 'status.get') {
          return { id: 'status', ok: true, result: { capabilities: viewCapabilities } }
        }
        if (method === 'mobileRelay.projectSections') {
          return { id: 'catalog', ok: true, result: { catalog } }
        }
        return {
          id: 'record',
          ok: true,
          result: mutatePersonalProjectOrder(runtime, RecordProjectOpenParams.parse(params))
        }
      }
    })
    const intent = JSON.stringify({
      writer: '10000000-0000-4000-8000-000000000000',
      previousWorktreeId,
      previousHost: 'local'
    })
    const args = {
      intent,
      viewClient,
      activation: { activated: true, repoId: 'a' }
    }
    await recordPersonalProjectRouteIntent({ ...args, intent: undefined })
    await recordPersonalProjectRouteIntent({
      ...args,
      activation: { activated: false, repoId: 'a' }
    })
    expect(calls).toEqual([])
    viewCapabilities = []
    await recordPersonalProjectRouteIntent(args)
    expect(calls).toEqual(['status.get'])
    calls.length = 0
    viewCapabilities = ['ui.personalProjectOrder.v1']
    await recordPersonalProjectRouteIntent(args)
    await recordPersonalProjectRouteIntent(args)
    expect(ui.personalProjectOrder?.projects['["local","local","repo:a"]']?.openCount).toBe(
      previousWorktreeId ? undefined : 1
    )
  }
)
