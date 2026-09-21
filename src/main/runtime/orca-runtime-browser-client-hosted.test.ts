import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const { startBrowserScreencastMock, browserSessionRegistryMock } = vi.hoisted(() => ({
  startBrowserScreencastMock: vi.fn(),
  browserSessionRegistryMock: {
    profiles: new Map([
      [
        'default',
        {
          id: 'default',
          scope: 'default',
          partition: 'persist:orca-browser',
          label: 'Default',
          source: null
        }
      ]
    ]),
    getDefaultProfile: vi.fn(),
    getProfile: vi.fn(),
    resolveKnownPartition: vi.fn(),
    createProfile: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

vi.mock('../browser/browser-screencast-stream', () => ({
  startBrowserScreencast: startBrowserScreencastMock
}))

vi.mock('../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: vi.fn(),
  waitForWorktreeTabRegistration: vi.fn()
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createHost(overrides: Partial<RuntimeBrowserCommandHost> = {}): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  const bridge = overrides.getAgentBrowserBridge
    ? overrides.getAgentBrowserBridge()
    : ({
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
        getActivePageId: vi.fn(() => 'page-1'),
        tabList: vi.fn(() => ({
          tabs: [
            {
              browserPageId: 'page-1',
              index: 0,
              url: 'about:blank',
              title: 'Browser',
              active: true
            }
          ]
        }))
      } as unknown as AgentBrowserBridge)
  return {
    resolveWorktreeSelector: async (selector) => ({ id: selector.replace(/^id:/, '') }),
    resolveBrowserWorkspace: async (selector) => ({ id: selector.replace(/^id:/, '') }),
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    getAuthoritativeWindow: vi.fn(),
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null),
    ...overrides,
    getAgentBrowserBridge: () => bridge
  } as unknown as RuntimeBrowserCommandHost
}

function publishClientPage(
  registry: RuntimeBrowserPageRegistry,
  overrides: { browserPageId: string; workspaceId?: string; active?: boolean }
): void {
  registry.publishClientPage({
    browserPageId: overrides.browserPageId,
    workspaceId: overrides.workspaceId ?? 'wt-1',
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:7',
    placement: {
      kind: 'client',
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: 9
    },
    url: 'https://client.test/',
    title: 'Client page',
    loading: false,
    active: overrides.active ?? true
  })
}

describe('RuntimeBrowserCommands client-hosted routing', () => {
  beforeEach(() => {
    startBrowserScreencastMock.mockReset()
    browserSessionRegistryMock.getDefaultProfile.mockReset()
    browserSessionRegistryMock.getDefaultProfile.mockImplementation(() =>
      browserSessionRegistryMock.profiles.get('default')
    )
    browserSessionRegistryMock.getProfile.mockReset()
    browserSessionRegistryMock.getProfile.mockImplementation(
      (profileId: string) => browserSessionRegistryMock.profiles.get(profileId) ?? null
    )
    browserSessionRegistryMock.resolveKnownPartition.mockReset()
    browserSessionRegistryMock.resolveKnownPartition.mockImplementation(
      (profileId: string | null | undefined) => {
        if (!profileId) {
          return 'persist:orca-browser'
        }
        return browserSessionRegistryMock.profiles.get(profileId)?.partition ?? null
      }
    )
  })

  it('creates an explicitly client-placed page without a server renderer or offscreen backend', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const createClientPage = vi.fn(async () => ({
      kind: 'client' as const,
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: 9
    }))
    const issueClientPageCommand = vi.fn(() => ({
      event: {} as never,
      result: Promise.resolve({ status: 'completed' as const })
    }))
    const resolveBrowserNetworkExecutionHost = vi.fn(async () => ({
      kind: 'native' as const,
      runtimeId: 'runtime-a',
      revision: 7
    }))
    const offscreenCreate = vi.fn()
    const send = vi.fn()
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never),
        getOffscreenBrowserBackend: vi.fn(
          () => ({ createTab: offscreenCreate }) as unknown as never
        ),
        resolveBrowserNetworkExecutionHost,
        getBrowserHostLeaseRegistry: () =>
          ({
            authorityRuntimeId: 'runtime-a',
            authorityEpoch: 'epoch-a',
            createClientPage,
            issueClientPageCommand
          }) as never
      })
    )

    await expect(
      commands.browserTabCreate(
        {
          worktree: 'id:wt-1',
          page: 'page-stable',
          url: 'https://remote.internal/',
          placement: { kind: 'client', browserHostClientId: 'host-a' }
        },
        { pairedDeviceId: 'device-a' }
      )
    ).resolves.toEqual({ browserPageId: 'page-stable' })

    expect(resolveBrowserNetworkExecutionHost).toHaveBeenCalledWith({ id: 'wt-1' })
    expect(createClientPage).toHaveBeenCalledWith({
      browserPageId: 'page-stable',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: JSON.stringify(['native', 'runtime-a', 7]),
      requiredCapabilities: ['automation-v1'],
      // Carried to the client so its page inventory can name the workspace after a restart.
      workspaceId: 'wt-1'
    })
    expect(issueClientPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-stable' }),
      { type: 'navigate', url: 'https://remote.internal/' }
    )
    expect(offscreenCreate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('moves a user-created client page into the clicked split group', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const markHeadlessBrowserSessionTabActive = vi.fn()
    const host = createHost({
      resolveBrowserNetworkExecutionHost: vi.fn(async () => ({
        kind: 'native' as const,
        runtimeId: 'runtime-a',
        revision: 7
      })),
      markHeadlessBrowserSessionTabActive,
      getBrowserHostLeaseRegistry: () =>
        ({
          authorityRuntimeId: 'runtime-a',
          authorityEpoch: 'epoch-a',
          createClientPage: vi.fn(async () => ({
            kind: 'client' as const,
            browserHostClientId: 'host-a',
            browserHostGeneration: 3,
            pageHostGeneration: 9
          })),
          issueClientPageCommand: vi.fn(() => ({
            event: {} as never,
            result: Promise.resolve({ status: 'completed' as const })
          }))
        }) as never
    })
    const commands = new RuntimeBrowserCommands(host)

    await commands.browserTabCreate(
      {
        worktree: 'id:wt-1',
        page: 'page-grouped',
        activate: true,
        targetGroupId: 'group-right',
        placement: { kind: 'client', browserHostClientId: 'host-a' }
      },
      { pairedDeviceId: 'device-a' }
    )
    expect(markHeadlessBrowserSessionTabActive).toHaveBeenCalledWith('wt-1', 'page-grouped', {
      targetGroupId: 'group-right',
      focusesHost: true,
      caller: { clientNavigationId: 'device-a', navigation: 'all' }
    })

    markHeadlessBrowserSessionTabActive.mockClear()
    await commands.browserTabCreate(
      {
        worktree: 'id:wt-1',
        page: 'page-background',
        placement: { kind: 'client', browserHostClientId: 'host-a' }
      },
      { pairedDeviceId: 'device-a' }
    )
    // Why: agent/background creates must not yank a connected client to the new tab.
    expect(markHeadlessBrowserSessionTabActive).not.toHaveBeenCalled()
  })

  it('keeps a background client page out of the workspace current-page slot', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const registry = new RuntimeBrowserPageRegistry()
    const commands = new RuntimeBrowserCommands(
      createHost({
        resolveBrowserNetworkExecutionHost: vi.fn(async () => ({
          kind: 'native' as const,
          runtimeId: 'runtime-a',
          revision: 7
        })),
        getRuntimeBrowserPageRegistry: () => registry,
        getBrowserHostLeaseRegistry: () =>
          ({
            authorityRuntimeId: 'runtime-a',
            authorityEpoch: 'epoch-a',
            createClientPage: vi.fn(async () => ({
              kind: 'client' as const,
              browserHostClientId: 'host-a',
              browserHostGeneration: 3,
              pageHostGeneration: 9
            })),
            issueClientPageCommand: vi.fn(() => ({
              event: {} as never,
              result: Promise.resolve({ status: 'completed' as const })
            }))
          }) as never
      })
    )

    // `active` is what browser.tabCurrent resolves for agents, so an opted-out create must not
    // take the slot from the page the user is actually on.
    await commands.browserTabCreate(
      {
        worktree: 'id:wt-1',
        page: 'page-background',
        activate: false,
        placement: { kind: 'client', browserHostClientId: 'host-a' }
      },
      { pairedDeviceId: 'device-a' }
    )

    expect(registry.getPage('page-background')).toMatchObject({ active: false })
  })

  it('publishes the proven client page before navigation and scopes it to the worktree', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const createProof = deferred<{
      kind: 'client'
      browserHostClientId: string
      browserHostGeneration: number
      pageHostGeneration: number
    }>()
    const navigationProof = deferred<{ status: 'completed' }>()
    const registry = new RuntimeBrowserPageRegistry()
    const order: string[] = []
    const publishClientPage = vi
      .spyOn(registry, 'publishClientPage')
      .mockImplementation((input) => {
        order.push('publish')
        return Reflect.apply(RuntimeBrowserPageRegistry.prototype.publishClientPage, registry, [
          input
        ])
      })
    const notifyHeadlessBrowserSessionTabsChanged = vi.fn(() => order.push('notify'))
    const issueClientPageCommand = vi.fn(() => {
      order.push('navigate')
      return { event: {} as never, result: navigationProof.promise }
    })
    const commands = new RuntimeBrowserCommands(
      createHost({
        resolveBrowserWorkspace: vi.fn(async () => ({ id: 'wt-1' })),
        resolveBrowserNetworkExecutionHost: vi.fn(async () => ({
          kind: 'native' as const,
          runtimeId: 'runtime-a',
          revision: 7
        })),
        getRuntimeBrowserPageRegistry: () => registry,
        notifyHeadlessBrowserSessionTabsChanged,
        getBrowserHostLeaseRegistry: () =>
          ({
            authorityRuntimeId: 'runtime-a',
            authorityEpoch: 'epoch-a',
            createClientPage: vi.fn(() => createProof.promise),
            issueClientPageCommand
          }) as never
      } as unknown as Partial<RuntimeBrowserCommandHost>)
    )

    const creation = commands.browserTabCreate(
      {
        worktree: 'id:wt-1',
        page: 'page-stable',
        url: 'https://remote.internal/',
        placement: { kind: 'client', browserHostClientId: 'host-a' }
      },
      { pairedDeviceId: 'device-a' }
    )

    expect(registry.listPages('wt-1')).toEqual([])
    expect(issueClientPageCommand).not.toHaveBeenCalled()
    createProof.resolve({
      kind: 'client',
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: 9
    })
    await vi.waitFor(() => expect(issueClientPageCommand).toHaveBeenCalledOnce())

    expect(order).toEqual(['publish', 'notify', 'navigate'])
    expect(publishClientPage).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'page-stable',
        workspaceId: 'wt-1',
        browserProfileId: 'default',
        url: 'about:blank',
        active: true
      })
    )
    navigationProof.resolve({ status: 'completed' })
    await expect(creation).resolves.toEqual({ browserPageId: 'page-stable' })
    expect(registry.getPage('page-stable')).toMatchObject({
      url: 'https://remote.internal/',
      loading: false
    })
  })

  it('retains a folder-scoped logical client page when navigation fails', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const registry = new RuntimeBrowserPageRegistry()
    const resolveBrowserWorkspace = vi.fn(async () => ({
      id: 'folder:folder-1',
      hostId: 'ssh:target-a' as const
    }))
    const resolveBrowserNetworkExecutionHost = vi.fn(async () => ({
      kind: 'ssh' as const,
      targetId: 'target-a',
      providerEpoch: 'provider-a',
      connectionGeneration: 4
    }))
    const offscreenCreate = vi.fn()
    const send = vi.fn()
    const commands = new RuntimeBrowserCommands(
      createHost({
        resolveBrowserWorkspace,
        resolveBrowserNetworkExecutionHost,
        getRuntimeBrowserPageRegistry: () => registry,
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never),
        getOffscreenBrowserBackend: vi.fn(
          () => ({ createTab: offscreenCreate }) as unknown as never
        ),
        getBrowserHostLeaseRegistry: () =>
          ({
            authorityRuntimeId: 'runtime-a',
            authorityEpoch: 'epoch-a',
            createClientPage: vi.fn(async () => ({
              kind: 'client' as const,
              browserHostClientId: 'host-a',
              browserHostGeneration: 3,
              pageHostGeneration: 9
            })),
            issueClientPageCommand: vi.fn(() => ({
              event: {} as never,
              result: Promise.resolve({
                status: 'failed' as const,
                errorCode: 'navigation_failed'
              })
            }))
          }) as never
      } as unknown as Partial<RuntimeBrowserCommandHost>)
    )

    await expect(
      commands.browserTabCreate(
        {
          worktree: 'id:folder:folder-1',
          page: 'page-folder',
          url: 'https://remote.internal/',
          placement: { kind: 'client', browserHostClientId: 'host-a' }
        },
        { pairedDeviceId: 'device-a' }
      )
    ).resolves.toEqual({ browserPageId: 'page-folder' })

    expect(resolveBrowserWorkspace).toHaveBeenCalledWith('id:folder:folder-1')
    expect(resolveBrowserNetworkExecutionHost).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'folder:folder-1', hostId: 'ssh:target-a' })
    )
    expect(registry.getPage('page-folder')).toMatchObject({
      workspaceId: 'folder:folder-1',
      url: 'about:blank',
      loading: false
    })
    expect(offscreenCreate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('lists, shows, and resolves the current client page on a browserless host', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const registry = new RuntimeBrowserPageRegistry()
    publishClientPage(registry, { browserPageId: 'page-client', workspaceId: 'folder:folder-1' })
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => null,
        getRuntimeBrowserPageRegistry: () => registry,
        resolveBrowserWorkspace: vi.fn(async () => ({ id: 'folder:folder-1' }))
      })
    )

    await expect(
      commands.browserTabList({ worktree: 'id:folder:folder-1' })
    ).resolves.toMatchObject({
      tabs: [
        {
          browserPageId: 'page-client',
          index: 0,
          url: 'https://client.test/',
          title: 'Client page',
          active: true,
          worktreeId: 'folder:folder-1'
        }
      ]
    })
    await expect(
      commands.browserTabShow({ worktree: 'id:folder:folder-1', page: 'page-client' })
    ).resolves.toMatchObject({ tab: { browserPageId: 'page-client' } })
    await expect(
      commands.browserTabCurrent({ worktree: 'id:folder:folder-1' })
    ).resolves.toMatchObject({ tab: { browserPageId: 'page-client' } })
  })

  it('switches logical client pages without invoking the server bridge', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const registry = new RuntimeBrowserPageRegistry()
    publishClientPage(registry, { browserPageId: 'page-a', active: true })
    publishClientPage(registry, { browserPageId: 'page-b', active: false })
    const notify = vi.fn()
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => null,
        getRuntimeBrowserPageRegistry: () => registry,
        resolveBrowserWorkspace: vi.fn(async () => ({ id: 'wt-1' })),
        notifyHeadlessBrowserSessionTabsChanged: notify
      })
    )

    await expect(
      commands.browserTabSwitch({ worktree: 'id:wt-1', page: 'page-b' })
    ).resolves.toEqual({ switched: 1, browserPageId: 'page-b' })
    expect(registry.getPage('page-a')?.active).toBe(false)
    expect(registry.getPage('page-b')?.active).toBe(true)
    expect(notify).toHaveBeenCalledWith('wt-1')
  })

  it('reports one global active client page across independently active workspaces', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const registry = new RuntimeBrowserPageRegistry()
    publishClientPage(registry, { browserPageId: 'page-a', workspaceId: 'wt-1' })
    publishClientPage(registry, { browserPageId: 'page-b', workspaceId: 'wt-2' })
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => null,
        getRuntimeBrowserPageRegistry: () => registry
      })
    )

    await expect(commands.browserTabCurrent({})).resolves.toMatchObject({
      tab: { browserPageId: 'page-b' }
    })
    await expect(commands.browserTabList({})).resolves.toMatchObject({
      tabs: [
        { browserPageId: 'page-a', active: false },
        { browserPageId: 'page-b', active: true }
      ]
    })
    await expect(commands.browserTabCurrent({ worktree: 'id:wt-1' })).resolves.toMatchObject({
      tab: { browserPageId: 'page-a' }
    })
  })

  it('makes a switched server tab globally active without clearing other workspace scopes', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const registry = new RuntimeBrowserPageRegistry()
    publishClientPage(registry, { browserPageId: 'page-client-a', workspaceId: 'wt-1' })
    publishClientPage(registry, { browserPageId: 'page-client-b', workspaceId: 'wt-2' })
    const tabSwitch = vi.fn(async () => ({ switched: 0, browserPageId: 'page-server' }))
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-server', 100]])),
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'page-server',
            index: 0,
            url: 'about:blank',
            title: 'Server page',
            active: true
          }
        ]
      })),
      tabSwitch
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getRuntimeBrowserPageRegistry: () => registry
      })
    )

    await expect(commands.browserTabSwitch({ page: 'page-server' })).resolves.toMatchObject({
      browserPageId: 'page-server'
    })
    expect(registry.listPages().every((page) => !page.active)).toBe(true)
    expect(registry.listPages('wt-1')[0]?.active).toBe(true)
    expect(registry.listPages('wt-2')[0]?.active).toBe(true)
    await expect(commands.browserTabCurrent({})).resolves.toMatchObject({
      tab: { browserPageId: 'page-server' }
    })
  })

  it('closes the exact client page and excludes it from server screencast', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const registry = new RuntimeBrowserPageRegistry()
    publishClientPage(registry, { browserPageId: 'page-client' })
    const issueClientPageCommand = vi.fn(() => ({
      event: {} as never,
      result: Promise.resolve({ status: 'completed' as const })
    }))
    const beginPageRetirement = vi.fn((browserPageId, placement) => ({
      browserPageId,
      placement
    }))
    const requireClientPage = vi.fn(() => registry.getPage('page-client')!.placement)
    const completePageRetirement = vi.fn(() => true)
    const retireRuntimeOwnedBrowserSessionTab = vi.fn()
    const notifyHeadlessBrowserSessionTabsChanged = vi.fn()
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => null,
        getRuntimeBrowserPageRegistry: () => registry,
        getBrowserHostLeaseRegistry: () =>
          ({
            authorityRuntimeId: 'runtime-a',
            authorityEpoch: 'epoch-a',
            issueClientPageCommand,
            requireClientPage,
            beginPageRetirement,
            completePageRetirement,
            getPlacement: () => registry.getPage('page-client')?.placement
          }) as never,
        resolveBrowserWorkspace: vi.fn(async () => ({ id: 'wt-1' })),
        retireRuntimeOwnedBrowserSessionTab,
        notifyHeadlessBrowserSessionTabsChanged
      })
    )

    await expect(
      commands.browserScreencast({ page: 'page-client', format: 'png' }, { sendBinary: vi.fn() })
    ).rejects.toThrow('do not support server screencast')
    expect(startBrowserScreencastMock).not.toHaveBeenCalled()

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-client' })
    ).resolves.toEqual({ closed: true })
    expect(issueClientPageCommand).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'page-client' }),
      expect.objectContaining({ type: 'closePage' })
    )
    expect(registry.getPage('page-client')).toBeUndefined()
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-client')
    expect(notifyHeadlessBrowserSessionTabsChanged).not.toHaveBeenCalled()
  })

  it('closes a retained client page whose host is gone without commanding it', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const registry = new RuntimeBrowserPageRegistry()
    publishClientPage(registry, { browserPageId: 'page-client' })
    const issueClientPageCommand = vi.fn()
    const requireClientPage = vi.fn(() => {
      throw new Error('browser_host_lease_required')
    })
    const retireRuntimeOwnedBrowserSessionTab = vi.fn()
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => null,
        getRuntimeBrowserPageRegistry: () => registry,
        getBrowserHostLeaseRegistry: () =>
          ({
            authorityRuntimeId: 'runtime-a',
            authorityEpoch: 'epoch-a',
            issueClientPageCommand,
            requireClientPage,
            beginPageRetirement: vi.fn(),
            completePageRetirement: vi.fn(() => true),
            // The fence released the placement while keeping the page listed.
            getPlacement: () => undefined
          }) as never,
        resolveBrowserWorkspace: vi.fn(async () => ({ id: 'wt-1' })),
        retireRuntimeOwnedBrowserSessionTab,
        notifyHeadlessBrowserSessionTabsChanged: vi.fn()
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-client' })
    ).resolves.toEqual({ closed: true })
    expect(issueClientPageCommand).not.toHaveBeenCalled()
    expect(requireClientPage).not.toHaveBeenCalled()
    expect(registry.getPage('page-client')).toBeUndefined()
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-client')
  })

  it('does not fall back to a server page after explicit client placement fails', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const offscreenCreate = vi.fn()
    const send = vi.fn()
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never),
        getOffscreenBrowserBackend: vi.fn(
          () => ({ createTab: offscreenCreate }) as unknown as never
        ),
        resolveBrowserNetworkExecutionHost: vi.fn(async () => ({
          kind: 'native' as const,
          runtimeId: 'runtime-a',
          revision: 7
        })),
        getBrowserHostLeaseRegistry: () =>
          ({
            authorityRuntimeId: 'runtime-a',
            authorityEpoch: 'epoch-a',
            createClientPage: vi.fn(async () => {
              throw new Error('browser_client_page_mount_failed')
            }),
            issueClientPageCommand: vi.fn()
          }) as never
      })
    )

    await expect(
      commands.browserTabCreate(
        {
          worktree: 'id:wt-1',
          page: 'page-stable',
          placement: { kind: 'client', browserHostClientId: 'host-a' }
        },
        { pairedDeviceId: 'device-a' }
      )
    ).rejects.toThrow('browser_client_page_mount_failed')
    expect(offscreenCreate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
