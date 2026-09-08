import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../transport/types'
import { selectHostWorkspaceListState } from '../worktree/host-workspace-list-state'
import type { HostScreenHostState } from '../worktree/host-screen-host-state'
import type { HostWorkspaceOperations } from '../worktree/host-workspace-operations'
import { useHybridHostScreenCatalog } from './use-hybrid-host-screen-catalog'
import { useHybridHostScreenState } from './use-hybrid-host-screen-state'

vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)) {
      useEffect(effect, [effect])
    }
  }
})
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() }))
  }
}))

const HOST_ID = 'paired-orca-desktop'

const hostState: HostScreenHostState = {
  cachedWorkspaces: () => null,
  cacheWorkspaces: () => {},
  cacheRepositories: () => {},
  loadPinnedWorkspaceIds: async () => new Set(),
  savePinnedWorkspaceIds: async () => {},
  loadIdentity: async () => ({ name: 'Desktop', publicKeyB64: '' }),
  recordConnected: async () => {}
}

const noopRepoMetadata = async (): Promise<void> => {}
const noopViewSettings = async (): Promise<void> => {}

function operations(args: {
  relayed: boolean
  listWorkspaces: HostWorkspaceOperations['listWorkspaces']
  fetchWorkspaceCatalog?: HostWorkspaceOperations['fetchWorkspaceCatalog']
}): HostWorkspaceOperations {
  return {
    ...(args.relayed ? { connectionStateIsRelayed: true } : {}),
    ...(args.fetchWorkspaceCatalog ? { fetchWorkspaceCatalog: args.fetchWorkspaceCatalog } : {}),
    getViewSettings: async () => null,
    setViewSettings: async () => {},
    listRepos: async () => [],
    listWorkspaces: args.listWorkspaces,
    setPinned: async () => {},
    removeWorkspace: async () => true,
    activateWorkspace: async () => {},
    sleepWorkspace: async () => {},
    notifyForeground: () => {},
    subscribeChanges: () => () => {}
  }
}

type Probe = {
  catalogError: string | null
  worktreesLoaded: boolean
  displayCount: number
  fetchWorktrees: () => Promise<void>
}

describe('hybrid host catalog first-load failure', () => {
  let renderer: ReactTestRenderer | null = null
  let probe: Probe | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    probe = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(ops: HostWorkspaceOperations, connState: ConnectionState = 'connected'): void {
    function CatalogProbe(): null {
      const state = useHybridHostScreenState(HOST_ID, undefined, hostState)
      state.workspaceOperationsRef.current = ops
      const catalog = useHybridHostScreenCatalog({
        operations: ops,
        connState,
        embedded: false,
        fetchRepoMetadata: noopRepoMetadata,
        hostId: HOST_ID,
        hostState,
        state,
        syncViewSettingsFromDesktop: noopViewSettings
      })
      probe = {
        catalogError: state.catalogError,
        worktreesLoaded: state.worktreesLoaded,
        displayCount: state.worktrees.length,
        fetchWorktrees: catalog.fetchWorktrees
      }
      return null
    }
    act(() => {
      renderer = create(createElement(CatalogProbe))
    })
  }

  function listState(): ReturnType<typeof selectHostWorkspaceListState> {
    const current = probe
    if (!current) {
      throw new Error('probe missing')
    }
    return selectHostWorkspaceListState({
      connState: 'connected',
      worktreesLoaded: current.worktreesLoaded,
      displayCount: current.displayCount,
      sectionCount: 0,
      catalogError: current.catalogError
    })
  }

  async function refetch(): Promise<void> {
    await act(async () => {
      await probe?.fetchWorktrees()
    })
  }

  it('keeps the never-loaded list in the loading state when the relayed first attempt fails', async () => {
    const listWorkspaces = vi.fn(async () => {
      throw new Error('network_error')
    })
    render(operations({ relayed: true, listWorkspaces }))
    await act(async () => {})

    expect(listWorkspaces).toHaveBeenCalledOnce()
    expect(probe?.catalogError).toBeNull()
    expect(listState()).toBe('loading')
  })

  it('reports the failure once the retry after the channel is up also fails', async () => {
    const listWorkspaces = vi.fn(async () => {
      throw new Error('network_error')
    })
    render(operations({ relayed: true, listWorkspaces }))
    await act(async () => {})
    expect(probe?.catalogError).toBeNull()

    await refetch()

    expect(listWorkspaces).toHaveBeenCalledTimes(2)
    expect(probe?.catalogError).toBe('network_error')
    expect(listState()).toBe('catalog-error')
  })

  it('reports a relayed failure that follows a successful load', async () => {
    let fail = false
    const listWorkspaces = vi.fn(async () => {
      if (fail) {
        throw new Error('network_error')
      }
      return []
    })
    render(operations({ relayed: true, listWorkspaces }))
    await act(async () => {})
    expect(probe?.worktreesLoaded).toBe(true)

    fail = true
    await refetch()

    expect(probe?.catalogError).toBe('network_error')
  })

  it('leaves the direct-socket build reporting its first failure immediately', async () => {
    const listWorkspaces = vi.fn(async () => {
      throw new Error('network_error')
    })
    render(operations({ relayed: false, listWorkspaces }))
    await act(async () => {})

    expect(listWorkspaces).toHaveBeenCalledOnce()
    expect(probe?.catalogError).toBe('network_error')
    expect(listState()).toBe('catalog-error')
  })
})

describe('hybrid host catalog snapshot-token polling', () => {
  let renderer: ReactTestRenderer | null = null
  let probe: Probe | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    probe = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(ops: HostWorkspaceOperations): void {
    function CatalogProbe(): null {
      const state = useHybridHostScreenState(HOST_ID, undefined, hostState)
      state.workspaceOperationsRef.current = ops
      const catalog = useHybridHostScreenCatalog({
        operations: ops,
        connState: 'connected',
        embedded: false,
        fetchRepoMetadata: noopRepoMetadata,
        hostId: HOST_ID,
        hostState,
        state,
        syncViewSettingsFromDesktop: noopViewSettings
      })
      probe = {
        catalogError: state.catalogError,
        worktreesLoaded: state.worktreesLoaded,
        displayCount: state.worktrees.length,
        fetchWorktrees: catalog.fetchWorktrees
      }
      return null
    }
    act(() => {
      renderer = create(createElement(CatalogProbe))
    })
  }

  it('prefers the snapshot-token poll over the full list when the binding offers one', async () => {
    const listWorkspaces = vi.fn(async () => [])
    const fetchWorkspaceCatalog = vi.fn(async () => ({
      kind: 'response' as const,
      invalidShape: false,
      commit: () => [] as never[]
    }))
    render(operations({ relayed: false, listWorkspaces, fetchWorkspaceCatalog }))
    await act(async () => {})

    expect(fetchWorkspaceCatalog).toHaveBeenCalledWith(HOST_ID)
    expect(listWorkspaces).not.toHaveBeenCalled()
    expect(probe?.worktreesLoaded).toBe(true)
  })

  // Why (STA-3123): a failed catalog request must not read as an empty host.
  it('surfaces the host error code rather than a generic transport failure', async () => {
    const fetchWorkspaceCatalog = vi.fn(async () => ({
      kind: 'request_failed' as const,
      code: 'worktree_list_unavailable'
    }))
    render(operations({ relayed: false, listWorkspaces: async () => [], fetchWorkspaceCatalog }))
    await act(async () => {})

    expect(probe?.catalogError).toBe('worktree_list_unavailable')
    expect(listStateFor(probe)).toBe('catalog-error')
  })

  it('reports an unreadable payload without applying rows', async () => {
    const fetchWorkspaceCatalog = vi.fn(async () => ({
      kind: 'response' as const,
      invalidShape: true,
      commit: () => null
    }))
    render(operations({ relayed: false, listWorkspaces: async () => [], fetchWorkspaceCatalog }))
    await act(async () => {})

    expect(probe?.catalogError).toBe('invalid_response')
    expect(probe?.worktreesLoaded).toBe(false)
  })
})

function listStateFor(current: Probe | null): ReturnType<typeof selectHostWorkspaceListState> {
  if (!current) {
    throw new Error('probe missing')
  }
  return selectHostWorkspaceListState({
    connState: 'connected',
    worktreesLoaded: current.worktreesLoaded,
    displayCount: current.displayCount,
    sectionCount: 0,
    catalogError: current.catalogError
  })
}
