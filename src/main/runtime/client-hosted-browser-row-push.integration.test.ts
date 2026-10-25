/**
 * Drives the real push seam: a real OrcaRuntimeService, the real lease registry, the real page
 * registry, and the real session-tabs announcement every client-page mutation already goes
 * through. The unit tests around the publisher can only prove it behaves once called.
 */
import { describe, expect, it } from 'vitest'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getBrowserHostLeaseRegistry } from './browser-host/browser-host-lease-registry-instance'
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

function createRuntime(deviceNames: Record<string, string> = {}): {
  runtime: OrcaRuntimeService
  events: ClientHostedBrowserRowsEvent[]
} {
  let session: WorkspaceSessionState = {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  const runtime = new OrcaRuntimeService(
    {
      ...storeBase,
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      }
    },
    undefined,
    { getPairedDeviceName: (pairedDeviceId) => deviceNames[pairedDeviceId] ?? null }
  )
  const events: ClientHostedBrowserRowsEvent[] = []
  runtime.setNotifier({
    clientHostedBrowserRowsChanged: (event) => events.push(event)
  } as never)
  return { runtime, events }
}

function attachHost(runtime: OrcaRuntimeService, browserHostClientId: string) {
  return getBrowserHostLeaseRegistry(runtime).attach({
    browserHostClientId,
    connectionId: `connection-${browserHostClientId}`,
    pairedDeviceId: `device-${browserHostClientId}`,
    hostCapabilities: ['webview']
  })
}

function placeAndPublish(
  runtime: OrcaRuntimeService,
  browserPageId: string,
  browserHostClientId: string
): RuntimeBrowserClientPlacement {
  const placement = getBrowserHostLeaseRegistry(runtime).placeClientPage(
    browserPageId,
    browserHostClientId
  )
  if (placement.kind !== 'client') {
    throw new Error('expected client placement')
  }
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId,
    workspaceId: WT,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:1',
    placement,
    pairedDeviceId: `device-${browserHostClientId}`,
    url: 'https://example.internal/docs',
    title: 'Internal docs',
    loading: false,
    active: true
  })
  return placement
}

describe('client-hosted browser row push', () => {
  it('pushes the row to the host window when the session-tabs announcement fires', () => {
    const { runtime, events } = createRuntime({ 'device-host-a': "Jinwoo's MacBook" })
    attachHost(runtime, 'host-a')
    placeAndPublish(runtime, 'page-a', 'host-a')

    runtime.notifyMobileSessionTabsChanged(WT)

    expect(events).toEqual([
      {
        worktreeId: WT,
        rows: [
          {
            browserPageId: 'page-a',
            worktreeId: WT,
            url: 'https://example.internal/docs',
            title: 'Internal docs',
            loading: false,
            browserHostClientId: 'host-a',
            hostDeviceName: "Jinwoo's MacBook",
            hostAbsent: false
          }
        ]
      }
    ])
  })

  it('flips the row to host-absent when the client that rendered it quits', () => {
    const { runtime, events } = createRuntime()
    const host = attachHost(runtime, 'host-a')
    placeAndPublish(runtime, 'page-a', 'host-a')
    runtime.notifyMobileSessionTabsChanged(WT)
    events.length = 0

    host.release()

    expect(events.at(-1)).toEqual({
      worktreeId: WT,
      rows: [expect.objectContaining({ browserPageId: 'page-a', hostAbsent: true })]
    })
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-a')).toBeDefined()
  })

  it('keeps naming the device of a retained page whose lease is gone', () => {
    const { runtime, events } = createRuntime({ 'device-host-a': 'Studio' })
    const host = attachHost(runtime, 'host-a')
    placeAndPublish(runtime, 'page-a', 'host-a')

    host.release()

    expect(events.at(-1)?.rows[0]).toMatchObject({ hostDeviceName: 'Studio', hostAbsent: true })
  })

  it('retracts the row when the page is retired', () => {
    const { runtime, events } = createRuntime()
    attachHost(runtime, 'host-a')
    const placement = placeAndPublish(runtime, 'page-a', 'host-a')
    runtime.notifyMobileSessionTabsChanged(WT)
    events.length = 0

    getRuntimeBrowserPageRegistry(runtime).retirePage('page-a', placement)
    runtime.retireRuntimeOwnedBrowserSessionTab(WT, 'page-a')

    expect(events).toEqual([{ worktreeId: WT, rows: [] }])
  })

  // Workspace removal drops its snapshot first; retraction must precede the snapshot guard.
  it('retracts rows for a worktree that has no session snapshot', () => {
    const { runtime, events } = createRuntime()
    attachHost(runtime, 'host-a')
    const placement = placeAndPublish(runtime, 'page-a', 'host-a')
    runtime.notifyMobileSessionTabsChanged()
    expect(events).toHaveLength(1)
    events.length = 0

    getRuntimeBrowserPageRegistry(runtime).retirePage('page-a', placement)
    runtime.retireRuntimeOwnedBrowserSessionTab(WT, 'page-a')

    expect(events).toEqual([{ worktreeId: WT, rows: [] }])
  })

  it('says nothing about a workspace that has no client-hosted page', () => {
    const { runtime, events } = createRuntime()

    runtime.notifyMobileSessionTabsChanged(WT)
    runtime.notifyMobileSessionTabsChanged()

    expect(events).toEqual([])
  })

  it('republishes every client-hosted workspace on an unscoped announcement', () => {
    const { runtime, events } = createRuntime()
    attachHost(runtime, 'host-a')
    placeAndPublish(runtime, 'page-a', 'host-a')
    events.length = 0

    runtime.notifyMobileSessionTabsChanged()

    expect(events).toEqual([
      { worktreeId: WT, rows: [expect.objectContaining({ browserPageId: 'page-a' })] }
    ])
  })

  it('serves the same rows to a renderer hydrating after a reload', () => {
    const { runtime } = createRuntime({ 'device-host-a': 'Studio' })
    attachHost(runtime, 'host-a')
    placeAndPublish(runtime, 'page-a', 'host-a')

    expect(runtime.listClientHostedBrowserRows()).toEqual([
      {
        worktreeId: WT,
        rows: [expect.objectContaining({ browserPageId: 'page-a', hostDeviceName: 'Studio' })]
      }
    ])
  })

  it('does not push when no host window is attached', () => {
    const { runtime, events } = createRuntime()
    runtime.setNotifier(null)
    attachHost(runtime, 'host-a')
    placeAndPublish(runtime, 'page-a', 'host-a')

    runtime.notifyMobileSessionTabsChanged(WT)

    expect(events).toEqual([])
    expect(runtime.listClientHostedBrowserRows()[0]?.rows).toHaveLength(1)
  })

  /** macOS last-window closure leaves the runtime alive; hydration-only rows must still be retractable. */
  it('closes a row the host window only ever learned about by hydrating', () => {
    const { runtime, events } = createRuntime()
    runtime.setNotifier(null)
    attachHost(runtime, 'host-a')
    const placement = placeAndPublish(runtime, 'page-a', 'host-a')
    runtime.notifyMobileSessionTabsChanged(WT)
    expect(events).toEqual([])

    runtime.setNotifier({
      clientHostedBrowserRowsChanged: (event: ClientHostedBrowserRowsEvent) => events.push(event)
    } as never)
    expect(runtime.listClientHostedBrowserRows()).toEqual([
      { worktreeId: WT, rows: [expect.objectContaining({ browserPageId: 'page-a' })] }
    ])
    events.length = 0

    // Retirement empties the registry before announcement; hydration must have recorded its delivery.
    expect(getRuntimeBrowserPageRegistry(runtime).retirePage('page-a', placement)).toBe(true)
    runtime.retireRuntimeOwnedBrowserSessionTab(WT, 'page-a')

    expect(events).toEqual([{ worktreeId: WT, rows: [] }])
  })
})

describe('client-hosted browser row metadata', () => {
  it('live-updates the pushed title and url', () => {
    const { runtime, events } = createRuntime()
    attachHost(runtime, 'host-a')
    const placement = placeAndPublish(runtime, 'page-a', 'host-a')
    events.length = 0

    getRuntimeBrowserPageRegistry(runtime).updatePageMetadata('page-a', placement, {
      url: 'https://example.internal/changelog',
      title: 'Changelog',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      revision: 1
    })
    runtime.notifyMobileSessionTabsChanged(WT)

    expect(events.at(-1)?.rows[0]).toMatchObject({
      url: 'https://example.internal/changelog',
      title: 'Changelog'
    })
  })
})
