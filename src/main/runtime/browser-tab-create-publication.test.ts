// Centralize placement bookkeeping so client-created pages retain targetGroupId.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './browser/browser-command-contracts'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import {
  BROWSER_TAB_CREATE_PLACEMENT_KINDS,
  BROWSER_TAB_CREATE_PUBLICATION_RULES,
  BROWSER_TAB_SWITCH_PLACEMENT_KINDS,
  BROWSER_TAB_SWITCH_PUBLICATION_RULES,
  browserTabCreateClientPageStartsActive,
  browserTabCreateTakesFocus,
  browserTabSwitchTakesFocus,
  publishCreatedBrowserSessionTab,
  publishSwitchedBrowserSessionTab,
  resolveBrowserTabCreateFocus,
  type BrowserTabCreatePublicationHost
} from './browser-tab-create-publication'

const { ipcMainOnMock, waitForTabRegistrationMock } = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  waitForTabRegistrationMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: ipcMainOnMock, removeListener: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

vi.mock('../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: waitForTabRegistrationMock,
  waitForWorktreeTabRegistration: vi.fn()
}))

vi.mock('../browser/browser-main-window-readiness', () => ({
  whenBrowserMainWindowReady: async () => null
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: () => ({ id: 'default', partition: 'persist:orca-browser' }),
    getProfile: () => null,
    resolveKnownPartition: () => 'persist:orca-browser'
  }
}))

function createCommandHost(
  overrides: Partial<RuntimeBrowserCommandHost>
): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial host fake; these tests reach only the methods it defines.
  return {
    resolveWorkspaceSelector: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    resolveBrowserWorkspace: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    getAgentBrowserBridge: () =>
      ({
        getRegisteredTabs: vi.fn(() => new Map([['page-created', 202]])),
        setActiveTab: vi.fn()
      }) as unknown as AgentBrowserBridge,
    getAuthoritativeWindow: vi.fn(),
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null),
    ...overrides
  } as unknown as RuntimeBrowserCommandHost
}

function createPublicationHost(registeredTabs: readonly [string, number][] = [['page-1', 101]]): {
  host: BrowserTabCreatePublicationHost
  setActiveTab: ReturnType<typeof vi.fn>
  markHeadlessBrowserSessionTabActive: ReturnType<typeof vi.fn>
  notifyHeadlessBrowserSessionTabsChanged: ReturnType<typeof vi.fn>
} {
  const setActiveTab = vi.fn()
  const markHeadlessBrowserSessionTabActive = vi.fn()
  const notifyHeadlessBrowserSessionTabsChanged = vi.fn()
  return {
    host: {
      getAgentBrowserBridge: () =>
        ({
          getRegisteredTabs: vi.fn(() => new Map(registeredTabs)),
          setActiveTab
        }) as never,
      markHeadlessBrowserSessionTabActive,
      notifyHeadlessBrowserSessionTabsChanged
    },
    setActiveTab,
    markHeadlessBrowserSessionTabActive,
    notifyHeadlessBrowserSessionTabsChanged
  }
}

describe('publishCreatedBrowserSessionTab', () => {
  // Pin the table independently of cases that derive their expectations from it.
  it('pins the bookkeeping each placement owns', () => {
    expect(BROWSER_TAB_CREATE_PUBLICATION_RULES).toEqual({
      client: {
        activatesBridgeTab: false,
        marksSessionTabFocus: true,
        notifiesSessionTabsChanged: true,
        hostRowSource: 'session-notify'
      },
      offscreen: {
        activatesBridgeTab: true,
        marksSessionTabFocus: true,
        notifiesSessionTabsChanged: false,
        hostRowSource: 'none'
      },
      renderer: {
        activatesBridgeTab: true,
        marksSessionTabFocus: false,
        notifiesSessionTabsChanged: false,
        hostRowSource: 'create-ipc'
      }
    })
  })

  it.each(BROWSER_TAB_CREATE_PLACEMENT_KINDS)(
    'moves a user-created %s tab into the clicked split group when the placement marks focus',
    (placementKind) => {
      const { host, markHeadlessBrowserSessionTabActive } = createPublicationHost()

      publishCreatedBrowserSessionTab(host, {
        placementKind,
        browserPageId: 'page-1',
        worktreeId: 'wt-1',
        focus: resolveBrowserTabCreateFocus({ activate: true }),
        targetGroupId: 'group-right'
      })

      if (BROWSER_TAB_CREATE_PUBLICATION_RULES[placementKind].marksSessionTabFocus) {
        expect(markHeadlessBrowserSessionTabActive).toHaveBeenCalledWith('wt-1', 'page-1', {
          targetGroupId: 'group-right',
          focusesHost: true
        })
      } else {
        expect(markHeadlessBrowserSessionTabActive).not.toHaveBeenCalled()
      }
    }
  )

  it.each(BROWSER_TAB_CREATE_PLACEMENT_KINDS)(
    'never marks a background %s create active',
    (placementKind) => {
      const { host, markHeadlessBrowserSessionTabActive } = createPublicationHost()

      for (const activate of [undefined, false]) {
        publishCreatedBrowserSessionTab(host, {
          placementKind,
          browserPageId: 'page-1',
          worktreeId: 'wt-1',
          focus: resolveBrowserTabCreateFocus({ activate }),
          targetGroupId: 'group-right'
        })
      }

      expect(markHeadlessBrowserSessionTabActive).not.toHaveBeenCalled()
    }
  )

  it.each(BROWSER_TAB_CREATE_PLACEMENT_KINDS)(
    'activates the bridge tab for a %s create only when the placement is bridge-backed',
    (placementKind) => {
      const { host, setActiveTab } = createPublicationHost()

      publishCreatedBrowserSessionTab(host, {
        placementKind,
        browserPageId: 'page-1',
        worktreeId: 'wt-1',
        focus: resolveBrowserTabCreateFocus({ activate: true })
      })

      if (BROWSER_TAB_CREATE_PUBLICATION_RULES[placementKind].activatesBridgeTab) {
        expect(setActiveTab).toHaveBeenCalledWith(101, 'wt-1')
      } else {
        expect(setActiveTab).not.toHaveBeenCalled()
      }
    }
  )

  it.each(BROWSER_TAB_CREATE_PLACEMENT_KINDS)(
    'notifies session-tab watchers for a %s create only when the placement owns the announcement',
    (placementKind) => {
      const { host, notifyHeadlessBrowserSessionTabsChanged } = createPublicationHost()

      publishCreatedBrowserSessionTab(host, {
        placementKind,
        browserPageId: 'page-1',
        worktreeId: 'wt-1',
        focus: resolveBrowserTabCreateFocus({ activate: true })
      })

      if (BROWSER_TAB_CREATE_PUBLICATION_RULES[placementKind].notifiesSessionTabsChanged) {
        expect(notifyHeadlessBrowserSessionTabsChanged).toHaveBeenCalledWith('wt-1')
      } else {
        expect(notifyHeadlessBrowserSessionTabsChanged).not.toHaveBeenCalled()
      }
    }
  )

  it('announces the created tab before it takes focus', () => {
    const order: string[] = []
    const host: BrowserTabCreatePublicationHost = {
      getAgentBrowserBridge: () => null,
      markHeadlessBrowserSessionTabActive: () => order.push('mark'),
      notifyHeadlessBrowserSessionTabsChanged: () => order.push('notify')
    }

    publishCreatedBrowserSessionTab(host, {
      placementKind: 'client',
      browserPageId: 'page-1',
      worktreeId: 'wt-1',
      focus: resolveBrowserTabCreateFocus({ activate: true })
    })

    expect(order).toEqual(['notify', 'mark'])
  })

  it('tolerates a host with no bridge and no session-tab surface', () => {
    expect(() =>
      publishCreatedBrowserSessionTab(
        { getAgentBrowserBridge: () => null },
        {
          placementKind: 'offscreen',
          browserPageId: 'page-1',
          worktreeId: 'wt-1',
          focus: resolveBrowserTabCreateFocus({ activate: true })
        }
      )
    ).not.toThrow()
  })

  it('skips bridge activation for a page the bridge has not registered', () => {
    const { host, setActiveTab } = createPublicationHost([['page-other', 101]])

    publishCreatedBrowserSessionTab(host, {
      placementKind: 'renderer',
      browserPageId: 'page-1',
      worktreeId: 'wt-1',
      focus: resolveBrowserTabCreateFocus({ activate: true })
    })

    expect(setActiveTab).not.toHaveBeenCalled()
  })

  it('skips the worktree-scoped announcement for an unscoped create', () => {
    const { host, notifyHeadlessBrowserSessionTabsChanged } = createPublicationHost()

    publishCreatedBrowserSessionTab(host, {
      placementKind: 'client',
      browserPageId: 'page-1',
      focus: resolveBrowserTabCreateFocus({ activate: true })
    })

    expect(notifyHeadlessBrowserSessionTabsChanged).not.toHaveBeenCalled()
  })
})

describe('browser tab-create activation defaults', () => {
  it('takes focus only on an explicit activate', () => {
    expect(browserTabCreateTakesFocus(true)).toBe(true)
    expect(browserTabCreateTakesFocus(false)).toBe(false)
    expect(browserTabCreateTakesFocus(undefined)).toBe(false)
  })

  it('starts a client page active unless the caller opts out', () => {
    expect(browserTabCreateClientPageStartsActive(true)).toBe(true)
    expect(browserTabCreateClientPageStartsActive(false)).toBe(false)
    expect(browserTabCreateClientPageStartsActive(undefined)).toBe(true)
  })
})

describe('browser tab-create focus resolution', () => {
  it('keeps a local create host-focusing, exactly as it was before navigation existed', () => {
    expect(resolveBrowserTabCreateFocus({ activate: true })).toEqual({
      navigation: 'all',
      selects: true,
      focusesHost: true,
      startsActive: true
    })
  })

  it('keeps a paired create on the caller when it names no audience', () => {
    // An old client cannot send `navigation`; being a paired caller is what narrows it.
    expect(resolveBrowserTabCreateFocus({ activate: true, clientKind: 'runtime' })).toMatchObject({
      navigation: 'caller',
      selects: true,
      focusesHost: false
    })
  })

  it.each(['caller', 'clients'] as const)('never focuses the host for navigation %s', (target) => {
    expect(resolveBrowserTabCreateFocus({ activate: true, navigation: target }).focusesHost).toBe(
      false
    )
  })

  it.each(['host', 'all'] as const)('focuses the host for navigation %s', (target) => {
    expect(resolveBrowserTabCreateFocus({ activate: true, navigation: target }).focusesHost).toBe(
      true
    )
  })

  it('selects nothing for a background create however it is addressed', () => {
    for (const navigation of ['caller', 'host', 'clients', 'all'] as const) {
      expect(resolveBrowserTabCreateFocus({ navigation })).toMatchObject({
        selects: false,
        focusesHost: false
      })
      expect(resolveBrowserTabCreateFocus({ activate: false, navigation })).toMatchObject({
        selects: false,
        focusesHost: false
      })
    }
  })

  it('leaves the client page registry default on activate alone', () => {
    expect(resolveBrowserTabCreateFocus({ navigation: 'caller' }).startsActive).toBe(true)
    expect(
      resolveBrowserTabCreateFocus({ activate: false, navigation: 'caller' }).startsActive
    ).toBe(false)
  })
})

describe('browser tab-create placement census', () => {
  // Exercise actual publication as well as the rule-derived cases.
  describe('through browserTabCreate', () => {
    beforeEach(() => {
      ipcMainOnMock.mockReset()
      waitForTabRegistrationMock.mockReset()
      waitForTabRegistrationMock.mockResolvedValue(undefined)
    })

    it('moves a user-created offscreen tab into the clicked split group', async () => {
      const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
      const markHeadlessBrowserSessionTabActive = vi.fn()
      const commands = new RuntimeBrowserCommands(
        createCommandHost({
          getOffscreenBrowserBackend: vi.fn(
            () =>
              ({
                createTab: vi.fn(async () => ({ browserPageId: 'page-created' })),
                closeTab: vi.fn()
              }) as never
          ),
          markHeadlessBrowserSessionTabActive
        })
      )

      await commands.browserTabCreate({
        worktree: 'id:wt-1',
        url: 'about:blank',
        activate: true,
        targetGroupId: 'group-right'
      })
      expect(markHeadlessBrowserSessionTabActive).toHaveBeenCalledWith('wt-1', 'page-created', {
        targetGroupId: 'group-right',
        focusesHost: true
      })

      markHeadlessBrowserSessionTabActive.mockClear()
      await commands.browserTabCreate({
        worktree: 'id:wt-1',
        url: 'about:blank',
        targetGroupId: 'group-right'
      })
      expect(markHeadlessBrowserSessionTabActive).not.toHaveBeenCalled()
    })

    it('leaves renderer tab focus to the create IPC instead of the session-tab marker', async () => {
      const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
      const webContents = { send: vi.fn() }
      webContents.send = vi.fn((_channel: string, data: { requestId: string }) => {
        const handler = ipcMainOnMock.mock.calls.find(
          ([eventName]) => eventName === 'browser:tabCreateReply'
        )?.[1] as
          | ((event: unknown, reply: { requestId: string; browserPageId?: string }) => void)
          | undefined
        handler?.({ sender: webContents } as never, {
          requestId: data.requestId,
          browserPageId: 'page-created'
        })
      })
      const markHeadlessBrowserSessionTabActive = vi.fn()
      const commands = new RuntimeBrowserCommands(
        createCommandHost({
          getAvailableAuthoritativeWindow: vi.fn(() => ({}) as never),
          getAuthoritativeWindow: vi.fn(() => ({ webContents }) as never),
          markHeadlessBrowserSessionTabActive
        })
      )

      await commands.browserTabCreate({
        worktree: 'id:wt-1',
        url: 'about:blank',
        activate: true,
        targetGroupId: 'group-right'
      })

      expect(webContents.send).toHaveBeenCalledWith(
        'browser:requestTabCreate',
        expect.objectContaining({ activate: true })
      )
      expect(markHeadlessBrowserSessionTabActive).not.toHaveBeenCalled()
    })

    it('does not focus the host renderer for a create addressed to the caller', async () => {
      const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
      const webContents = { send: vi.fn() }
      webContents.send = vi.fn((_channel: string, data: { requestId: string }) => {
        const handler = ipcMainOnMock.mock.calls.find(
          ([eventName]) => eventName === 'browser:tabCreateReply'
        )?.[1] as
          | ((event: unknown, reply: { requestId: string; browserPageId?: string }) => void)
          | undefined
        handler?.({ sender: webContents } as never, {
          requestId: data.requestId,
          browserPageId: 'page-created'
        })
      })
      const commands = new RuntimeBrowserCommands(
        createCommandHost({
          getAvailableAuthoritativeWindow: vi.fn(() => ({}) as never),
          getAuthoritativeWindow: vi.fn(() => ({ webContents }) as never)
        })
      )

      await commands.browserTabCreate(
        { worktree: 'id:wt-1', url: 'about:blank', activate: true, navigation: 'caller' },
        { pairedDeviceId: 'device-a', clientKind: 'runtime' }
      )

      expect(webContents.send).toHaveBeenCalledWith(
        'browser:requestTabCreate',
        expect.objectContaining({ activate: false })
      )
    })

    it('still places a caller-addressed client page in the clicked split group', async () => {
      const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
      const markHeadlessBrowserSessionTabActive = vi.fn()
      const commands = new RuntimeBrowserCommands(
        createCommandHost({
          getOffscreenBrowserBackend: vi.fn(
            () =>
              ({
                createTab: vi.fn(async () => ({ browserPageId: 'page-created' })),
                closeTab: vi.fn()
              }) as never
          ),
          markHeadlessBrowserSessionTabActive
        })
      )

      await commands.browserTabCreate(
        {
          worktree: 'id:wt-1',
          url: 'about:blank',
          activate: true,
          navigation: 'caller',
          targetGroupId: 'group-right'
        },
        { pairedDeviceId: 'device-a', clientKind: 'runtime' }
      )

      // Suppressing focus must preserve the requested group move.
      expect(markHeadlessBrowserSessionTabActive).toHaveBeenCalledWith('wt-1', 'page-created', {
        targetGroupId: 'group-right',
        focusesHost: false,
        caller: { clientNavigationId: 'device-a', navigation: 'caller' }
      })
    })
  })
})

describe('publishSwitchedBrowserSessionTab', () => {
  // Pin the table independently of rule-derived cases.
  it('pins the bookkeeping each switch placement owns', () => {
    expect(BROWSER_TAB_SWITCH_PUBLICATION_RULES).toEqual({
      client: { marksSessionTabFocus: true, notifiesSessionTabsChanged: true },
      bridge: { marksSessionTabFocus: true, notifiesSessionTabsChanged: false }
    })
  })

  it('moves the session active tab only when the switch carries focus', () => {
    for (const placementKind of BROWSER_TAB_SWITCH_PLACEMENT_KINDS) {
      const focused = createPublicationHost()
      publishSwitchedBrowserSessionTab(focused.host, {
        placementKind,
        browserPageId: 'page-1',
        worktreeId: 'wt-1',
        focus: true
      })
      // Switch retains its existing host-facing semantics.
      expect(focused.markHeadlessBrowserSessionTabActive).toHaveBeenCalledWith('wt-1', 'page-1', {
        focusesHost: true
      })

      for (const focus of [false, undefined]) {
        const unfocused = createPublicationHost()
        publishSwitchedBrowserSessionTab(unfocused.host, {
          placementKind,
          browserPageId: 'page-1',
          worktreeId: 'wt-1',
          focus
        })
        expect(
          unfocused.markHeadlessBrowserSessionTabActive,
          `${placementKind} switch with focus=${focus} must not yank a connected client`
        ).not.toHaveBeenCalled()
      }
    }
  })

  it('announces a client switch whether or not it took focus, and never a bridge switch', () => {
    for (const focus of [true, false, undefined]) {
      const client = createPublicationHost()
      publishSwitchedBrowserSessionTab(client.host, {
        placementKind: 'client',
        browserPageId: 'page-1',
        worktreeId: 'wt-1',
        focus
      })
      expect(client.notifyHeadlessBrowserSessionTabsChanged).toHaveBeenCalledWith('wt-1')

      const bridge = createPublicationHost()
      publishSwitchedBrowserSessionTab(bridge.host, {
        placementKind: 'bridge',
        browserPageId: 'page-1',
        worktreeId: 'wt-1',
        focus
      })
      expect(bridge.notifyHeadlessBrowserSessionTabsChanged).not.toHaveBeenCalled()
    }
  })

  it('skips the worktree-scoped announcement for an unscoped switch', () => {
    const { host, notifyHeadlessBrowserSessionTabsChanged } = createPublicationHost()
    publishSwitchedBrowserSessionTab(host, {
      placementKind: 'client',
      browserPageId: 'page-1',
      focus: true
    })
    expect(notifyHeadlessBrowserSessionTabsChanged).not.toHaveBeenCalled()
  })

  it('tolerates a host with no session-tab surface', () => {
    expect(() =>
      publishSwitchedBrowserSessionTab(
        { getAgentBrowserBridge: () => null } as BrowserTabCreatePublicationHost,
        { placementKind: 'bridge', browserPageId: 'page-1', worktreeId: 'wt-1', focus: true }
      )
    ).not.toThrow()
  })
})

describe('browser tab-switch focus rule', () => {
  it('takes focus only on an explicit focus flag', () => {
    expect(browserTabSwitchTakesFocus(true)).toBe(true)
    expect(browserTabSwitchTakesFocus(false)).toBe(false)
    expect(browserTabSwitchTakesFocus(undefined)).toBe(false)
  })
})

describe('browser tab-switch placement census', () => {
  describe('through browserTabSwitch', () => {
    function createClientSwitchHost(overrides: Partial<RuntimeBrowserCommandHost>): {
      host: RuntimeBrowserCommandHost
      registry: RuntimeBrowserPageRegistry
    } {
      const registry = new RuntimeBrowserPageRegistry()
      for (const [browserPageId, active] of [
        ['page-a', true],
        ['page-b', false]
      ] as const) {
        registry.publishClientPage({
          browserPageId,
          workspaceId: 'wt-1',
          browserProfileId: 'default',
          executionHostKey: 'native:runtime-a:7',
          placement: {
            kind: 'client',
            browserHostClientId: 'host-a',
            browserHostGeneration: 3,
            pageHostGeneration: 9
          },
          url: 'https://client.test/',
          loading: false,
          active
        })
      }
      return {
        host: createCommandHost({
          getAgentBrowserBridge: () => null,
          getRuntimeBrowserPageRegistry: () => registry,
          ...overrides
        }),
        registry
      }
    }

    it('marks a focused client switch active and leaves an unfocused one alone', async () => {
      const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
      const markHeadlessBrowserSessionTabActive = vi.fn()
      const notifyHeadlessBrowserSessionTabsChanged = vi.fn()
      const { host, registry } = createClientSwitchHost({
        markHeadlessBrowserSessionTabActive,
        notifyHeadlessBrowserSessionTabsChanged
      })
      const commands = new RuntimeBrowserCommands(host)

      await expect(
        commands.browserTabSwitch({ worktree: 'id:wt-1', page: 'page-b', focus: true })
      ).resolves.toEqual({ switched: 1, browserPageId: 'page-b' })
      expect(registry.getPage('page-b')?.active).toBe(true)
      expect(markHeadlessBrowserSessionTabActive).toHaveBeenCalledWith('wt-1', 'page-b', {
        focusesHost: true
      })
      expect(notifyHeadlessBrowserSessionTabsChanged).toHaveBeenCalledWith('wt-1')

      markHeadlessBrowserSessionTabActive.mockClear()
      notifyHeadlessBrowserSessionTabsChanged.mockClear()
      await commands.browserTabSwitch({ worktree: 'id:wt-1', page: 'page-a' })
      expect(markHeadlessBrowserSessionTabActive).not.toHaveBeenCalled()
      expect(registry.getPage('page-a')?.active).toBe(true)
      expect(notifyHeadlessBrowserSessionTabsChanged).toHaveBeenCalledWith('wt-1')
    })

    it('marks a focused bridge switch active and leaves an unfocused one alone', async () => {
      const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
      const markHeadlessBrowserSessionTabActive = vi.fn()
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
        tabSwitch: vi.fn(async () => ({ switched: 0, browserPageId: 'page-server' }))
      } as unknown as AgentBrowserBridge
      const commands = new RuntimeBrowserCommands(
        createCommandHost({
          getAgentBrowserBridge: () => bridge,
          markHeadlessBrowserSessionTabActive
        })
      )

      await commands.browserTabSwitch({ worktree: 'id:wt-1', page: 'page-server', focus: true })
      expect(markHeadlessBrowserSessionTabActive).toHaveBeenCalledWith('wt-1', 'page-server', {
        focusesHost: true
      })

      markHeadlessBrowserSessionTabActive.mockClear()
      await commands.browserTabSwitch({ worktree: 'id:wt-1', page: 'page-server' })
      expect(markHeadlessBrowserSessionTabActive).not.toHaveBeenCalled()
    })
  })
})
