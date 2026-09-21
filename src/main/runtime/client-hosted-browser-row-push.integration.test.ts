/**
 * Drives the real push seam: a real OrcaRuntimeService, the real lease registry, the real page
 * registry, and the real session-tabs announcement every client-page mutation already goes
 * through. The unit tests around the publisher can only prove it behaves once called.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'
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

    // Real fence path: releasing the lease retains the page and re-announces the workspace.
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

  // Why: worktree removal deletes the session snapshot before it closes the workspace's client
  // pages, so the retraction has to run ahead of the snapshot guard — otherwise the host keeps
  // rows for a workspace that is gone. The bare announcement below publishes rows without ever
  // building a snapshot, which is the same state removal leaves behind.
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

  /**
   * The whole no-window round trip macOS makes ordinary: closing the last window clears the
   * notifier but leaves the runtime serving the paired client, so a page opened in that gap only
   * ever reaches the next window through hydration. Closing that row is the one exit it has.
   */
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

    // browserTabClose retires the registry page before it announces, so the announcement already
    // sees an empty workspace — exactly the shape the never-published suppression swallows.
    expect(getRuntimeBrowserPageRegistry(runtime).retirePage('page-a', placement)).toBe(true)
    runtime.retireRuntimeOwnedBrowserSessionTab(WT, 'page-a')

    expect(events).toEqual([{ worktreeId: WT, rows: [] }])
  })
})

// Why: the metadata publish is the only thing that makes the row's title real, and it reaches the
// host through the same announcement rather than a channel of its own.
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

// Keep the harness honest: a runtime that never pushes would satisfy every negative case above.
describe('push harness', () => {
  it('observes the notifier the runtime was given', () => {
    const clientHostedBrowserRowsChanged = vi.fn()
    const { runtime } = createRuntime()
    runtime.setNotifier({ clientHostedBrowserRowsChanged } as never)
    attachHost(runtime, 'host-a')
    placeAndPublish(runtime, 'page-a', 'host-a')

    runtime.notifyMobileSessionTabsChanged(WT)

    expect(clientHostedBrowserRowsChanged).toHaveBeenCalledOnce()
  })
})
