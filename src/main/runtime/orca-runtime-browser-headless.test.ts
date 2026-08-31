import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const {
  ipcMainOnMock,
  webContentsFromIdMock,
  waitForTabRegistrationMock,
  waitForWorktreeTabRegistrationMock,
  browserSessionRegistryMock
} = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  waitForTabRegistrationMock: vi.fn(),
  waitForWorktreeTabRegistrationMock: vi.fn(),
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
      ],
      [
        'profile-isolated',
        {
          id: 'profile-isolated',
          scope: 'isolated',
          partition: 'persist:orca-browser-session-profile-isolated',
          label: 'Isolated',
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
  ipcMain: { on: ipcMainOnMock, removeListener: vi.fn() },
  webContents: { fromId: webContentsFromIdMock }
}))

vi.mock('../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: waitForTabRegistrationMock,
  waitForWorktreeTabRegistration: waitForWorktreeTabRegistrationMock
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

function createHost(overrides: Partial<RuntimeBrowserCommandHost> = {}): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  const bridge = overrides.getAgentBrowserBridge
    ? overrides.getAgentBrowserBridge()
    : ({
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
        getActivePageId: vi.fn(() => 'page-1'),
        tabList: vi.fn(() => ({ tabs: [] }))
      } as unknown as AgentBrowserBridge)
  return {
    resolveWorktreeSelector: async (selector) => ({ id: selector.replace(/^id:/, '') }),
    resolveBrowserWorkspace: async (selector) => ({ id: selector.replace(/^id:/, '') }),
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    getAuthoritativeWindow: vi.fn(),
    getAvailableAuthoritativeWindow: vi.fn(),
    getOffscreenBrowserBackend: vi.fn(() => null),
    ...overrides,
    getAgentBrowserBridge: () => bridge
  } as unknown as RuntimeBrowserCommandHost
}

describe('RuntimeBrowserCommands headless close and forwarding', () => {
  beforeEach(() => {
    ipcMainOnMock.mockReset()
    webContentsFromIdMock.mockReset()
    waitForTabRegistrationMock.mockReset()
    waitForTabRegistrationMock.mockResolvedValue(undefined)
    waitForWorktreeTabRegistrationMock.mockReset()
    waitForWorktreeTabRegistrationMock.mockResolvedValue(undefined)
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
      (profileId: string | null | undefined) =>
        profileId
          ? (browserSessionRegistryMock.profiles.get(profileId)?.partition ?? null)
          : 'persist:orca-browser'
    )
  })

  it('closes a headless tab via the offscreen backend without a renderer round-trip', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => false })
    const closeTab = vi.fn(async () => {})
    const retireRuntimeOwnedBrowserSessionTab = vi.fn()
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-offscreen', 202]])),
      getActivePageId: vi.fn(() => 'page-offscreen'),
      getActiveWebContentsId: vi.fn(() => 202)
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab: vi.fn(), closeTab })),
        retireRuntimeOwnedBrowserSessionTab
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-offscreen' })
    ).resolves.toEqual({ closed: true })
    expect(closeTab).toHaveBeenCalledWith('page-offscreen')
    // Why: without retirement, paired clients keep a dead session tab after an RPC close.
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-offscreen')
    expect(ipcMainOnMock).not.toHaveBeenCalledWith('browser:tabCloseReply', expect.anything())
    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-other' })
    ).rejects.toMatchObject({ code: 'browser_tab_not_found' })
    expect(closeTab).toHaveBeenCalledTimes(1)
    // Why the unknown page still reaches retirement: it is the ghost probe — a session row whose
    // page this runtime no longer has is the one thing left to close. This host reports no such
    // row, so the close still fails closed rather than claiming it removed something.
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledTimes(2)
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenLastCalledWith('wt-1', 'page-other')
  })

  it('closes the active headless tab on an implicit close', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => false })
    const closeTab = vi.fn(async () => {})
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-active', 303]])),
      getActivePageId: vi.fn(() => 'page-active'),
      getActiveWebContentsId: vi.fn(() => 303)
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab: vi.fn(), closeTab }))
      })
    )

    await expect(commands.browserTabClose({ worktree: 'id:wt-1' })).resolves.toEqual({
      closed: true
    })
    expect(closeTab).toHaveBeenCalledWith('page-active')
  })

  it('reports not-closed when no headless tab can be resolved', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const closeTab = vi.fn(async () => {})
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map()),
      getActivePageId: vi.fn(() => null),
      getActiveWebContentsId: vi.fn(() => null)
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab: vi.fn(), closeTab }))
      })
    )

    await expect(commands.browserTabClose({ worktree: 'id:wt-1' })).resolves.toEqual({
      closed: false
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('forwards an unresolved worktree to the bridge unchanged for keyboard inserttext', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const keyboardInsertText = vi.fn().mockResolvedValue({ inserted: true })
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
      keyboardInsertText
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send: vi.fn() } }) as never)
      })
    )

    await commands.browserKeyboardInsertText({ text: 'hello' })
    expect(keyboardInsertText).toHaveBeenCalledWith('hello', undefined, undefined)
  })
})
