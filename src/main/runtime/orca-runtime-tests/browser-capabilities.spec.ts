import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  RuntimeBrowserCommands,
  deleteWorktreeHistoryDirMock,
  electronMocks,
  getBrowserHostLeaseRegistry,
  getRuntimeBrowserPageRegistry,
  headlessBrowserTabsUnchanged,
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause,
  setRuntimeTerminalUnavailableCause
} from '../orca-runtime-test-mocks.spec'
import type { RuntimeMobileSessionTabsResult } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  createRuntime,
  store
} from '../orca-runtime-test-fixtures.spec'
import {
  attachClientBrowserHost,
  publishClientHostedPage
} from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('advertises headless browser capability when an offscreen backend backs a windowless host', () => {
    const runtime = createRuntime()
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })

    const capabilities = runtime.getStatus().capabilities
    // Headless serve can still create/stream pages, so screencast is supported...
    expect(capabilities).toContain('browser.screencast.v1')
    // ...and the headless marker tells clients not to fall back to a local tab.
    expect(capabilities).toContain('browser.headless.v1')
    expect(capabilities).toContain('browser.certificate-trust.v1')
  })

  it('advertises only while headless browser commands remain live', () => {
    let available = true
    setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host), {
      headless: true,
      isAvailable: () => available
    })
    const status = createRuntime().getStatus()

    expect(status.capabilities).toContain('browser.headless.v1')
    expect(status.capabilities).not.toContain('browser.screencast.v1')
    expect(status.capabilities).not.toContain('browser.certificate-trust.v1')
    expect(status.degradations).toBeUndefined()

    available = false
    const degraded = createRuntime().getStatus()
    expect(degraded.capabilities).not.toContain('browser.headless.v1')
    // A provider that resolved and then died is a health failure, never a config mistake.
    expect(degraded.degradations).toEqual([
      {
        code: 'browser_unavailable',
        capability: 'browser.headless.v1',
        reason: 'provider_unhealthy',
        message: 'The browser provider started but is no longer answering health checks.'
      }
    ])
  })
  it('surfaces live offscreen load failures in headless browser snapshots', () => {
    const runtime = createRuntime()
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })
    runtime.setAgentBrowserBridge({
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'page-certificate-error',
            index: 0,
            url: 'https://localhost:3443/',
            title: 'Local HTTPS',
            active: true,
            loadError: {
              code: -202,
              description: 'ERR_CERT_AUTHORITY_INVALID',
              validatedUrl: 'https://localhost:3443/'
            },
            certificateFailure: {
              challengeId: 'challenge-1',
              browserPageId: 'page-certificate-error',
              errorCode: -202,
              error: 'ERR_CERT_AUTHORITY_INVALID',
              origin: 'https://localhost:3443',
              displayHost: 'localhost:3443',
              canProceed: true,
              observedAt: 123
            }
          }
        ]
      }))
    } as never)
    const browserTabs = runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)
    expect(browserTabs).toContainEqual(
      expect.objectContaining({
        type: 'browser',
        browserPageId: 'page-certificate-error',
        loadError: {
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/'
        },
        certificateFailure: {
          challengeId: 'challenge-1',
          browserPageId: 'page-certificate-error',
          errorCode: -202,
          error: 'ERR_CERT_AUTHORITY_INVALID',
          origin: 'https://localhost:3443',
          displayHost: 'localhost:3443',
          canProceed: true,
          observedAt: 123
        }
      })
    )
  })

  it('synthesizes runtime-owned client pages without a server browser backend', () => {
    const runtime = createRuntime()
    getRuntimeBrowserPageRegistry(runtime).publishClientPage({
      browserPageId: 'page-client',
      workspaceId: TEST_WORKTREE_ID,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-a',
      placement: {
        kind: 'client',
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      },
      url: 'https://remote.internal/',
      title: 'Remote app',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      active: true
    })

    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([
      {
        type: 'browser',
        id: 'page-client',
        title: 'Remote app',
        browserWorkspaceId: 'page-client',
        browserPageId: 'page-client',
        browserProfileId: 'profile-a',
        executionHostKey: 'execution-a',
        placement: {
          kind: 'client',
          browserHostClientId: 'host-a',
          browserHostGeneration: 3,
          pageHostGeneration: 9
        },
        url: 'https://remote.internal/',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        isActive: true
      }
    ])
  })

  it('publishes a runtime-owned client page through the session-tab listener', () => {
    const runtime = createRuntime()
    runtime['mobileSessionTabsByWorktree'].set(TEST_WORKTREE_ID, {
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:1',
      snapshotVersion: 1,
      activeGroupId: 'group-1',
      activeTabId: null,
      activeTabType: null,
      tabGroups: [{ id: 'group-1', activeTabId: null, tabOrder: [] }],
      tabs: []
    })
    const snapshots: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => snapshots.push(snapshot))
    getRuntimeBrowserPageRegistry(runtime).publishClientPage({
      browserPageId: 'page-client',
      workspaceId: TEST_WORKTREE_ID,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-a',
      placement: {
        kind: 'client',
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      },
      url: 'about:blank',
      loading: true,
      active: true
    })

    runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)

    expect(snapshots.at(-1)?.tabs).toContainEqual(
      expect.objectContaining({
        type: 'browser',
        browserPageId: 'page-client',
        loading: true,
        placement: expect.objectContaining({
          kind: 'client',
          browserHostClientId: 'host-a',
          pageHostGeneration: 9
        })
      })
    )
    unsubscribe()
  })

  it('preserves a live client page across headed renderer graph updates and prunes it after retirement', async () => {
    const runtime = createRuntime()
    const pages = getRuntimeBrowserPageRegistry(runtime)
    const placement = {
      kind: 'client' as const,
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: 9
    }
    runtime.attachWindow(1)
    const rendererSnapshot = (snapshotVersion: number) => ({
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer:client-page-preservation',
      snapshotVersion,
      activeGroupId: 'group-1',
      activeTabId: null,
      activeTabType: null,
      tabGroups: [{ id: 'group-1', activeTabId: null, tabOrder: [] }],
      tabs: []
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(1)]
    })
    pages.publishClientPage({
      browserPageId: 'page-client',
      workspaceId: TEST_WORKTREE_ID,
      browserProfileId: 'profile-a',
      executionHostKey: 'execution-a',
      placement,
      url: 'https://remote.internal/',
      loading: false,
      active: true
    })
    runtime.notifyMobileSessionTabsChanged(TEST_WORKTREE_ID)

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(2)]
    })
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(3)]
    })

    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([
      expect.objectContaining({ browserPageId: 'page-client', placement })
    ])

    expect(pages.retirePage('page-client', placement)).toBe(true)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(3)]
    })
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])

    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [rendererSnapshot(4)]
    })
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('detects headless browser-tab changes by field, treating absent and null loadError alike', () => {
    const base = {
      type: 'browser' as const,
      id: 'page-1',
      title: 'Local',
      browserWorkspaceId: 'page-1',
      browserPageId: 'page-1',
      url: 'https://localhost:3443/',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: true
    }
    const err = {
      code: -202,
      description: 'ERR_CERT_AUTHORITY_INVALID',
      validatedUrl: 'https://localhost:3443/'
    }
    const certificateFailure = {
      challengeId: 'challenge-1',
      browserPageId: 'page-1',
      errorCode: -202,
      error: 'ERR_CERT_AUTHORITY_INVALID',
      origin: 'https://localhost:3443',
      displayHost: 'localhost:3443',
      canProceed: true,
      observedAt: 123
    }
    const unchanged = (a: unknown[], b: unknown[]): boolean =>
      headlessBrowserTabsUnchanged(a as never, b as never)

    // Absent vs explicit null loadError are equivalent (the JSON.stringify trap).
    expect(unchanged([{ ...base }], [{ ...base, loadError: null }])).toBe(true)
    expect(unchanged([{ ...base, loadError: err }], [{ ...base, loadError: { ...err } }])).toBe(
      true
    )
    // A load-error-only change (identical ids/order) must not be missed.
    expect(unchanged([{ ...base }], [{ ...base, loadError: err }])).toBe(false)
    expect(
      unchanged([{ ...base, loadError: err }], [{ ...base, loadError: { ...err, code: -200 } }])
    ).toBe(false)
    expect(
      unchanged(
        [{ ...base, certificateFailure }],
        [{ ...base, certificateFailure: { ...certificateFailure } }]
      )
    ).toBe(true)
    expect(unchanged([{ ...base }], [{ ...base, certificateFailure }])).toBe(false)
    expect(
      unchanged(
        [{ ...base, certificateFailure }],
        [{ ...base, certificateFailure: { ...certificateFailure, challengeId: 'challenge-2' } }]
      )
    ).toBe(false)
    // Scalar and length changes are detected.
    expect(unchanged([{ ...base }], [{ ...base, title: 'Changed' }])).toBe(false)
    expect(unchanged([{ ...base }], [{ ...base, isActive: false }])).toBe(false)
    expect(unchanged([{ ...base }], [{ ...base }, { ...base, id: 'page-2' }])).toBe(false)
  })

  it('does not advertise headless browser capability when a renderer window exists', () => {
    const runtime = createRuntime()
    electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab: vi.fn() })

    expect(runtime.getStatus().capabilities).not.toContain('browser.headless.v1')
    // Desktop webviews still host certificate trust, so the proceed capability stays advertised for remote clients controlling those pages.
    expect(runtime.getStatus().capabilities).toContain('browser.certificate-trust.v1')
  })

  it('declares browser unavailability when no browser provider resolves', async () => {
    setRuntimeBrowserCommandsFactory(null)
    const runtime = createRuntime()
    const status = runtime.getStatus()

    expect(status.capabilities).not.toContain('browser.headless.v1')
    expect(status.capabilities).not.toContain('browser.certificate-trust.v1')
    expect(status.capabilities).not.toContain('browser.screencast.v1')
    expect(status.degradations).toEqual([
      {
        code: 'browser_unavailable',
        capability: 'browser.headless.v1',
        reason: 'unknown',
        message:
          'Browser automation is unavailable on this host, and the cause could not be determined.'
      }
    ])
    const browserCalls = Object.entries(runtime).filter(
      ([name, value]) => /^browser[A-Z]/.test(name) && typeof value === 'function'
    )
    expect(browserCalls.length).toBeGreaterThan(50)
    for (const [name, call] of browserCalls) {
      const invoke =
        name === 'browserScreencast'
          ? () =>
              (call as CallableFunction)(
                { format: 'jpeg' },
                { sendBinary: () => true, emit: () => undefined }
              )
          : () => (call as CallableFunction)({})
      await expect(Promise.resolve().then(invoke)).rejects.toMatchObject({
        code: 'browser_unavailable'
      })
    }
  })

  it('reports the driver as missing instead of telling a configured operator to configure it', () => {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({ reason: 'driver_missing' })

    const [degradation] = createRuntime().getStatus().degradations ?? []

    expect(degradation).toEqual({
      code: 'browser_unavailable',
      capability: 'browser.headless.v1',
      reason: 'driver_missing',
      message:
        'ORCA_BROWSER_EXECUTABLE is set, but the bundled agent-browser driver is missing or not executable on this host, so Chromium cannot be driven.'
    })
    // The whole point: never send someone to set a variable they already set.
    expect(degradation?.message).not.toMatch(/set ORCA_BROWSER_EXECUTABLE/)
  })

  it('carries the underlying error to the client when a provider failed to start', () => {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({
      reason: 'electron_start_failed',
      detail: 'sidecar exited with code 1'
    })

    const [degradation] = createRuntime().getStatus().degradations ?? []

    expect(degradation).toEqual({
      code: 'browser_unavailable',
      capability: 'browser.headless.v1',
      reason: 'electron_start_failed',
      detail: 'sidecar exited with code 1',
      message:
        'The installed Electron browser provider failed to start. (sidecar exited with code 1)'
    })
  })

  it('blames the missing desktop window when a renderer-backed factory is installed', () => {
    const [degradation] = createRuntime().getStatus().degradations ?? []

    expect(degradation).toMatchObject({
      reason: 'desktop_window_unavailable',
      message: 'Browser automation on this host needs a desktop window, and none is available.'
    })
  })

  it('keeps the degradation wire-safe for peers that predate structured causes', () => {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({ reason: 'executable_not_found', detail: '/nope/chromium' })

    const [degradation] = createRuntime().getStatus().degradations ?? []

    // Old clients read only these three: the closed code must not move and the human
    // sentence must stand alone without the optional fields.
    expect(degradation?.code).toBe('browser_unavailable')
    expect(degradation?.capability).toBe('browser.headless.v1')
    expect(degradation?.message).toBe(
      'ORCA_BROWSER_EXECUTABLE points at a path that does not exist. (/nope/chromium)'
    )
  })

  it('reports a host that cannot load node-pty, instead of that host never answering', () => {
    // The alternative to reporting it is the process dying inside the dynamic loader,
    // which reaches a client as a dropped connection with no cause attached.
    setRuntimeTerminalUnavailableCause({
      reason: 'libc_floor',
      detail: 'the binary requires GLIBC_2.34'
    })

    const degradations = createRuntime().getStatus().degradations ?? []

    expect(degradations).toContainEqual({
      code: 'terminal_unavailable',
      capability: 'terminal.pty.v1',
      reason: 'libc_floor',
      detail: 'the binary requires GLIBC_2.34',
      message:
        "This host's node-pty binary was built against a newer C library than the host provides, so the dynamic loader refuses it. Rebuild node-pty on this host, or deploy a build whose prebuilt binary matches this platform's libc. (the binary requires GLIBC_2.34)"
    })
  })

  it('reports browser and terminal loss together, because they fail independently', () => {
    setRuntimeBrowserCommandsFactory(null)
    setRuntimeBrowserUnavailableCause({ reason: 'unconfigured' })
    setRuntimeTerminalUnavailableCause({ reason: 'dependency_missing' })

    const codes = (createRuntime().getStatus().degradations ?? []).map((entry) => entry.code)

    expect(codes).toEqual(['browser_unavailable', 'terminal_unavailable'])
  })

  it('says nothing about terminals when no precondition proved them broken', () => {
    // Silence must mean "nothing proved it broken", never "proved working" — a host that
    // never ran the precondition has no verdict to publish.
    const degradations = createRuntime().getStatus().degradations ?? []
    expect(degradations.map((entry) => entry.code)).not.toContain('terminal_unavailable')
  })

  it('closes a worktree’s offscreen browser pages when its metadata is removed (leak fix)', () => {
    const runtime = createRuntime()
    const closeTab = vi.fn().mockResolvedValue(undefined)
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab })
    runtime.setAgentBrowserBridge({
      tabList: vi.fn((worktreeId: string) =>
        worktreeId === TEST_WORKTREE_ID
          ? { tabs: [{ browserPageId: 'page-a' }, { browserPageId: 'page-b' }] }
          : { tabs: [] }
      )
    } as never)

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(closeTab).toHaveBeenCalledWith('page-a')
    expect(closeTab).toHaveBeenCalledWith('page-b')
    expect(closeTab).toHaveBeenCalledTimes(2)
  })

  it('does not rescue a paired renderer PTY into a recreated worktree', () => {
    const runtime = createRuntime()
    const ptyId = 'paired-pty-deleted-worktree'
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId: 'tab-deleted-worktree',
      leafId: 'leaf-deleted-worktree'
    })
    const internals = runtime as unknown as {
      pairedRendererSessionOwnedPtyIds: Set<string>
    }
    internals.pairedRendererSessionOwnedPtyIds.add(ptyId)

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(internals.pairedRendererSessionOwnedPtyIds.has(ptyId)).toBe(false)
  })

  it('closes a worktree’s client-hosted browser pages when its metadata is removed (leak fix)', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    const removed = await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)
    const survivor = await publishClientHostedPage(
      runtime,
      host,
      'page-other',
      `${TEST_REPO_ID}::/tmp/other`
    )

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(host.takeCommands()).toEqual([
      expect.objectContaining({
        browserPageId: 'page-removed',
        pageHostGeneration: removed.pageHostGeneration,
        command: {
          type: 'closePage',
          targetAuthority: {
            authorityRuntimeId: runtime.getRuntimeId(),
            authorityEpoch: getBrowserHostLeaseRegistry(runtime).authorityEpoch,
            browserHostClientId: removed.browserHostClientId,
            browserHostGeneration: removed.browserHostGeneration,
            pageHostGeneration: removed.pageHostGeneration
          }
        }
      })
    ])
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-removed')).toBeUndefined()
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-other')?.placement).toEqual(
      survivor
    )
  })

  it('does not republish a removed worktree’s client tabs to a same-id recreate', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    // The store's surviving metadata stands in for a recreate at the same path: the ID resolves again.
    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([])
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('drops a client page record even when its close command cannot be issued', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)
    // The client's command transport is gone but its lease has not fenced yet.
    host.detachDelivery()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-removed')).toBeUndefined()
    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([])
    // The close really did fail, and its rejection was reported rather than left unhandled.
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not close its client page'),
        expect.objectContaining({
          browserPageId: 'page-removed',
          error: expect.objectContaining({ message: 'browser_host_command_delivery_required' })
        })
      )
    )
    warn.mockRestore()
  })

  it('leaves client-hosted pages alone when another host still owns the same worktree id', async () => {
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' }),
      removeWorktreeMeta: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const host = attachClientBrowserHost(runtime)
    const placement = await publishClientHostedPage(runtime, host, 'page-kept', TEST_WORKTREE_ID)

    runtime['removeWorktreeMetadataAndHistory'](
      runtimeStore as never,
      TEST_WORKTREE_ID,
      'runtime:env-b'
    )

    expect(host.takeCommands()).toEqual([])
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-kept')?.placement).toEqual(
      placement
    )
  })

  it('preserves bare-id runtime state when removing a different qualified owner', () => {
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' }),
      removeWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      removeWorktreeMetadataAndHistory: (
        runtimeStore: typeof store,
        worktreeId: string,
        hostId: string
      ) => void
    }
    const localSession = { tabs: [{ id: 'local-tab' }] }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, localSession)

    internals.removeWorktreeMetadataAndHistory(
      runtimeStore as typeof store,
      TEST_WORKTREE_ID,
      'runtime:env-b'
    )

    expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'runtime:env-b')
    expect(internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)).toBe(localSession)
  })

  it('preserves bare-id runtime state when removed-host metadata masks another owner', () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, connectionId: 'ssh-1' }
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'ssh:ssh-1' }),
      removeWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      removeWorktreeMetadataAndHistory: (
        runtimeStore: typeof store,
        worktreeId: string,
        hostId: string
      ) => void
    }
    const survivingSession = { tabs: [{ id: 'same-id-local-tab' }] }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, survivingSession)
    deleteWorktreeHistoryDirMock.mockClear()

    internals.removeWorktreeMetadataAndHistory(
      runtimeStore as typeof store,
      TEST_WORKTREE_ID,
      'ssh:ssh-1'
    )

    expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'ssh:ssh-1')
    expect(internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)).toBe(survivingSession)
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })
})
