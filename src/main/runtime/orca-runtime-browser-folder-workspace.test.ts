/**
 * Browser commands issued from a Folder Workspace terminal scope themselves by `folder:<id>`.
 * The git-only selector grammar cannot match that, so every target resolution here has to go
 * through the folder-aware resolver or the command silently lands in the UI-focused workspace.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const FOLDER_KEY = 'folder:52d2e7a3-c08f-4d0e-9771-f7581df19b6c'

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

/**
 * Stands in for the runtime's folder-aware resolver: a `folder:` key is a workspace of its own,
 * anything else is a git worktree id.
 */
function resolveWorkspace(selector: string): { id: string } {
  const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
  if (workspaceSelector.startsWith('folder:')) {
    return { id: workspaceSelector }
  }
  if (!workspaceSelector.includes('::')) {
    throw new Error('selector_not_found')
  }
  return { id: workspaceSelector }
}

function createHost(overrides: Partial<RuntimeBrowserCommandHost> = {}): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  const bridge = overrides.getAgentBrowserBridge
    ? overrides.getAgentBrowserBridge()
    : ({
        getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
        getActivePageId: vi.fn(() => 'page-1'),
        snapshot: vi.fn(async () => ({ snapshot: 'tree', refs: [] }))
      } as unknown as AgentBrowserBridge)
  return {
    resolveBrowserWorkspace: async (selector: string) => resolveWorkspace(selector),
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    getAuthoritativeWindow: vi.fn(),
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null),
    ...overrides,
    getAgentBrowserBridge: () => bridge
  } as unknown as RuntimeBrowserCommandHost
}

describe('browser commands targeting a Folder Workspace', () => {
  beforeEach(() => {
    ipcMainOnMock.mockReset()
    webContentsFromIdMock.mockReset()
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => false })
    waitForTabRegistrationMock.mockReset()
    waitForTabRegistrationMock.mockResolvedValue(undefined)
    waitForWorktreeTabRegistrationMock.mockReset()
    waitForWorktreeTabRegistrationMock.mockResolvedValue(undefined)
    browserSessionRegistryMock.resolveKnownPartition.mockReset()
    browserSessionRegistryMock.resolveKnownPartition.mockReturnValue('persist:orca-browser')
  })

  it('snapshots the folder workspace named by the caller, not the focused one', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const snapshot = vi.fn(async () => ({ snapshot: 'tree', refs: [] }))
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
      getActivePageId: vi.fn(() => 'page-1'),
      snapshot
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(createHost({ getAgentBrowserBridge: () => bridge }))

    await commands.browserSnapshot({ worktree: FOLDER_KEY })

    expect(snapshot).toHaveBeenCalledWith(FOLDER_KEY, undefined)
  })

  it('keeps an explicit page scoped to the folder workspace that was named', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const snapshot = vi.fn(async () => ({ snapshot: 'tree', refs: [] }))
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-7', 107]])),
      getActivePageId: vi.fn(() => 'page-7'),
      snapshot
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(createHost({ getAgentBrowserBridge: () => bridge }))

    await commands.browserSnapshot({ worktree: `id:${FOLDER_KEY}`, page: 'page-7' })

    expect(snapshot).toHaveBeenCalledWith(FOLDER_KEY, 'page-7')
  })

  it('creates a tab in the folder workspace the caller named', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const createTab = vi.fn(async () => ({ browserPageId: 'page-new' }))
    const commands = new RuntimeBrowserCommands(
      createHost({
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab, closeTab: vi.fn() }) as never),
        notifyHeadlessBrowserSessionTabsChanged: vi.fn()
      })
    )

    await expect(
      commands.browserTabCreate({ url: 'https://example.com', worktree: FOLDER_KEY })
    ).resolves.toEqual({ browserPageId: 'page-new' })
    expect(createTab).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: FOLDER_KEY, url: 'https://example.com' })
    )
  })

  it('still refuses a selector that names no workspace at all', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const commands = new RuntimeBrowserCommands(createHost())

    await expect(commands.browserSnapshot({ worktree: 'name:gone' })).rejects.toThrow(
      'selector_not_found'
    )
  })
})
