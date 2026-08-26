/**
 * Drives the runtime's own wiring: a real OrcaRuntimeService, the real page registry, and the real
 * session-tabs announcement every client-page mutation already goes through.
 *
 * The store here is a fake holding one session object -- enough to prove the runtime writes and
 * reads back through its own seam, and nothing about the Store's write paths. Those are covered by
 * store-runtime-authored-session-writes.test.ts, which drives the real Store.
 *
 * The unit tests around the persistence module can only prove it behaves once called. Whether it
 * is called at all -- and whether the session it writes is the one a restarted runtime reads back
 * -- lives in the runtime's own wiring, which is where the first end-to-end attempt broke.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
import { isRestoredClientHostedBrowserPlacement } from './client-hosted-browser-page-persistence'
import { OrcaRuntimeService } from './orca-runtime'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const WT = 'repo-1::/tmp/worktree-a'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

/** One profile on disk, shared by a runtime and whatever replaces it. */
function createProfile() {
  const state = {
    session: {
      activeRepoId: 'repo-1',
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {}
    } as WorkspaceSessionState
  }
  return {
    get session() {
      return state.session
    },
    store: {
      ...storeBase,
      getWorkspaceSession: () => state.session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        state.session = next
      }
    }
  }
}

function startRuntime(profile: ReturnType<typeof createProfile>): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(profile.store, undefined, {})
  runtime.rehydrateClientHostedBrowserPages()
  return runtime
}

function placeAndPublish(runtime: OrcaRuntimeService, browserPageId: string): void {
  const placement = getBrowserHostLeaseRegistry(runtime).placeClientPage(browserPageId, 'host-a')
  if (placement.kind !== 'client') {
    throw new Error('expected client placement')
  }
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId,
    workspaceId: WT,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement,
    pairedDeviceId: 'device-a',
    url: 'https://example.internal/docs',
    title: 'Internal docs',
    loading: false,
    active: true
  })
}

function attachHost(runtime: OrcaRuntimeService) {
  return getBrowserHostLeaseRegistry(runtime).attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-host-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview']
  })
}

describe('client-hosted browser page persistence through the runtime', () => {
  it('writes the page into the session the announcement already fires on', () => {
    const profile = createProfile()
    const runtime = startRuntime(profile)
    attachHost(runtime)
    placeAndPublish(runtime, 'page-a')

    runtime.notifyMobileSessionTabsChanged(WT)

    expect(profile.session.clientHostedBrowserPagesByWorktree?.[WT]).toEqual([
      expect.objectContaining({
        browserPageId: 'page-a',
        workspaceId: WT,
        browserProfileId: 'profile-a',
        pairedDeviceId: 'device-a',
        url: 'https://example.internal/docs',
        title: 'Internal docs'
      })
    ])
  })

  it('hands the page to a replacement runtime as a held row', () => {
    const profile = createProfile()
    const first = startRuntime(profile)
    attachHost(first)
    placeAndPublish(first, 'page-a')
    first.notifyMobileSessionTabsChanged(WT)

    // A new process reading the same profile: no lease, no guest, no in-memory record.
    const replacement = startRuntime(profile)

    const restored = getRuntimeBrowserPageRegistry(replacement).getPage('page-a')
    expect(restored).toMatchObject({
      workspaceId: WT,
      url: 'https://example.internal/docs',
      pairedDeviceId: 'device-a',
      loading: false,
      active: false
    })
    expect(
      isRestoredClientHostedBrowserPlacement(restored!.placement as RuntimeBrowserClientPlacement)
    ).toBe(true)
    // Held, not live: no placement exists for it, which is what makes the row host-absent.
    expect(getBrowserHostLeaseRegistry(replacement).getPlacement('page-a')).toBeUndefined()
  })

  it('takes the page back out of the session when it is closed', () => {
    const profile = createProfile()
    const runtime = startRuntime(profile)
    attachHost(runtime)
    placeAndPublish(runtime, 'page-a')
    runtime.notifyMobileSessionTabsChanged(WT)

    const page = getRuntimeBrowserPageRegistry(runtime).getPage('page-a')!
    getRuntimeBrowserPageRegistry(runtime).retirePage('page-a', page.placement)
    runtime.notifyMobileSessionTabsChanged(WT)

    expect(profile.session.clientHostedBrowserPagesByWorktree?.[WT]).toBeUndefined()
    expect(getRuntimeBrowserPageRegistry(startRuntime(profile)).listPages()).toEqual([])
  })

  it('keeps a page whose host quit, so the row survives both a quit and a restart', () => {
    const profile = createProfile()
    const runtime = startRuntime(profile)
    const host = attachHost(runtime)
    placeAndPublish(runtime, 'page-a')
    runtime.notifyMobileSessionTabsChanged(WT)

    // Real fence path: releasing the lease retains the page and re-announces the workspace.
    host.release()

    expect(getRuntimeBrowserPageRegistry(startRuntime(profile)).getPage('page-a')).toBeDefined()
  })
})
