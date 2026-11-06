import { buildProjectSectionCatalog } from '../worktree/project-section-catalog'
import { buildSections } from '../worktree/workspace-list-sections'
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { createElement, useEffect } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../src/shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { buildMobileProjectSectionCatalog } from '../../../src/shared/mobile-project-sections-contract'
import { mutatePersonalProjectOrder } from '../../../src/shared/personal-project-order-writes'
import {
  RecordProjectOpenParams,
  SetProjectPinnedParams
} from '../../../src/shared/rpc-contract/personal-project-order-params'
import type { Repo } from '../../../src/shared/repo-types'
import { useHostWorktreeActions } from './use-host-worktree-actions'
import { useHostViewSettings } from './use-host-view-settings'
import { useHostScreenState } from './use-host-screen-state'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { ProjectSectionCatalogSchema } from '../../../src/shared/project-section-catalog-schema'

vi.mock('expo-router', () => ({}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('../storage/preferences', () => ({ savePinnedIds: async () => {} }))
vi.mock('../transport/host-removal-lifecycle', () => ({ removeHostAndCloseClient: async () => {} }))
vi.mock('../host-route-exit', () => ({ leaveHostRoute: () => {} }))
vi.mock('../storage/mirrored-storage-keys', () => ({
  readMirroredKeyOrStore: async () => JSON.stringify({ hostId: 'host', worktreeId: 'b::/b' })
}))
vi.mock('./use-host-pending-view-changes', () => ({
  useSwitchedHostPendingViewChanges: () => null
}))

const a: Repo = {
  id: 'a',
  path: '/a',
  displayName: 'Alpha',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local'
}
const b: Repo = { ...a, id: 'b', path: '/b', displayName: 'Beta' }
const served = ProjectSectionCatalogSchema.parse(
  buildMobileProjectSectionCatalog([a, b], projectHostSetupProjectionFromRepos([a, b]), 'manual')
)
const rows: Worktree[] = [a, b].map((repo) => ({
  worktreeId: `${repo.id}::${repo.path}`,
  repoId: repo.id,
  hostId: 'local',
  repo: repo.displayName,
  displayName: repo.displayName,
  branch: 'main',
  path: repo.path,
  liveTerminalCount: 0,
  hasAttachedPty: false,
  unread: false,
  isPinned: false,
  linkedPR: null
}))
let tree: ReturnType<typeof create> | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

describe('mobile personal project actions', () => {
  it('counts only acknowledged deliberate project transitions and reads back pins/modes', async () => {
    let ui = getDefaultUIState()
    let supportsPersonalOrder = true
    let activationAccepted = true
    let settingsAccepted = true
    const runtime = {
      getUIState: () => ui,
      updateUIState: (patch: Partial<typeof ui>) => (ui = { ...ui, ...patch })
    }
    const sendRequest = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
      if (method === 'worktree.activate') {
        return activationAccepted
          ? { id: 'open', ok: true, result: { activated: true } }
          : { id: 'open', ok: false, error: { code: 'refused', message: 'refused' } }
      }
      if (method === 'ui.recordProjectOpen') {
        return {
          id: 'usage',
          ok: true,
          result: mutatePersonalProjectOrder(runtime, RecordProjectOpenParams.parse(params))
        }
      }
      if (method === 'ui.setProjectPinned') {
        return {
          id: 'pin',
          ok: true,
          result: mutatePersonalProjectOrder(runtime, SetProjectPinnedParams.parse(params))
        }
      }
      if (method === 'ui.set' && !settingsAccepted) {
        return { id: 'mode', ok: false, error: { code: 'refused', message: 'refused' } }
      }
      if (
        method === 'ui.set' &&
        typeof params === 'object' &&
        params &&
        'projectOrderBy' in params &&
        params.projectOrderBy === 'name'
      ) {
        ui = { ...ui, projectOrderBy: 'name' }
      }
      return { id: 'ui', ok: true, result: { ui } }
    })
    const client = stubRpcClient({ sendRequest })
    const held: {
      actions?: ReturnType<typeof useHostWorktreeActions>
      settings?: ReturnType<typeof useHostViewSettings>
      mode?: string | null
    } = {}
    function Probe() {
      const state = useHostScreenState('host')
      useEffect(() => {
        state.clientRef.current = client
        state.setWorktrees(rows)
        state.setServedProjectSections(served)
      }, [])
      held.actions = useHostWorktreeActions({
        client,
        connState: 'connected',
        embedded: false,
        fetchWorktrees: async () => {},
        forgetHostClient: () => {},
        hostCapabilities: supportsPersonalOrder ? ['ui.personalProjectOrder.v1'] : [],
        hostId: 'host',
        pathname: '/h/host',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: row navigation only calls these two router methods.
        router: { push: () => {}, replace: () => {} } as unknown as Parameters<
          typeof useHostWorktreeActions
        >[0]['router'],
        state
      })
      held.settings = useHostViewSettings({
        client,
        connState: 'connected',
        state,
        hostCapabilities: supportsPersonalOrder ? ['ui.personalProjectOrder.v1'] : []
      })
      held.mode = state.view.projectOrderBy
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    await act(async () => {
      await held.actions?.openWorktreeSession(rows[0])
    })
    expect(ui.personalProjectOrder?.projects['["local","local","repo:a"]'].openCount).toBe(1)
    await act(async () => {
      await held.actions?.openWorktreeSession(rows[0])
    })
    expect(ui.personalProjectOrder?.projects['["local","local","repo:a"]'].openCount).toBe(1)
    activationAccepted = false
    await act(async () => {
      await held.actions?.openWorktreeSession(rows[1])
    })
    expect(ui.personalProjectOrder?.projects['["local","local","repo:b"]']).toBeUndefined()
    await act(async () => {
      await held.settings?.toggleProjectPin(a)
    })
    expect(ui.personalProjectOrder?.projects['["local","local","repo:a"]'].pinned).toBe(true)
    await act(async () => {
      await held.settings?.setProjectOrderBy('name')
    })
    expect(held.mode).toBe('name')
    settingsAccepted = false
    await act(async () => {
      await held.settings?.setProjectOrderBy('frequent')
    })
    expect(held.mode).toBe('name')
    supportsPersonalOrder = false
    await act(async () => {
      tree?.update(createElement(Probe))
    })
    const beforeUnsupported = sendRequest.mock.calls.length
    await act(async () => {
      await held.settings?.setProjectOrderBy('frequent')
      await held.settings?.toggleProjectPin(a)
    })
    expect(sendRequest.mock.calls).toHaveLength(beforeUnsupported)
  })
})

it.each(['recent', 'frequent', 'name', 'manual'] as const)(
  'projects personal %s and independent pins through the mobile catalog decoder and section builder',
  (mode) => {
    const personalProjectOrder = {
      projects: {
        '["local","local","repo:a"]': { lastOpenedAt: 300, openCount: 1 },
        '["local","local","repo:b"]': { lastOpenedAt: 100, openCount: 5 }
      },
      settledOperations: []
    }
    const catalog = buildProjectSectionCatalog({ ...served, personalProjectOrder }, [], null, mode)
    const sections = buildSections(
      [
        { ...rows[0], lastActivityAt: 1 },
        { ...rows[1], lastActivityAt: 9999 }
      ],
      'recent',
      NO_WORKSPACE_ROW_FILTERS,
      '',
      'repo',
      new Set(),
      catalog
    )
    expect(sections.map((section) => section.title)).toEqual(
      mode === 'frequent' ? ['Beta', 'Alpha'] : ['Alpha', 'Beta']
    )
    const pinned = buildProjectSectionCatalog(
      {
        ...served,
        personalProjectOrder: {
          ...personalProjectOrder,
          projects: {
            ...personalProjectOrder.projects,
            '["local","local","repo:b"]': {
              ...personalProjectOrder.projects['["local","local","repo:b"]'],
              pinned: true
            }
          }
        }
      },
      [],
      null,
      mode
    )
    expect(
      buildSections(rows, 'recent', NO_WORKSPACE_ROW_FILTERS, '', 'repo', new Set(), pinned).map(
        (section) => section.title
      )
    ).toEqual(['Beta', 'Alpha'])
  }
)

it('clears personal summaries on a client switch without changing an empty view', async () => {
  let client = stubRpcClient({ sendRequest: async () => ({ id: 'read', ok: true, result: {} }) })
  const held: { state?: ReturnType<typeof useHostScreenState>; initial?: object } = {}
  function Probe() {
    const state = useHostScreenState('host')
    held.state = state
    held.initial ??= state.viewRef.current
    useHostViewSettings({ client, connState: 'connected', state })
    return null
  }
  await act(async () => {
    tree = create(createElement(Probe))
  })
  expect(held.state?.viewRef.current).toBe(held.initial)
  await act(async () => {
    const state = held.state
    if (!state) {
      throw new Error('missing probe')
    }
    const next = {
      ...state.viewRef.current,
      personalProjectOrder: {
        revision: 9,
        projects: { alpha: { pinned: true } },
        settledOperations: []
      }
    }
    state.viewRef.current = next
    state.setView(next)
  })
  client = stubRpcClient({ sendRequest: async () => ({ id: 'read', ok: true, result: {} }) })
  await act(async () => {
    tree?.update(createElement(Probe))
  })
  expect(held.state?.viewRef.current.personalProjectOrder).toBeUndefined()
})
