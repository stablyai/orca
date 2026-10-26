import { describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './browser/browser-command-contracts'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

/** Registry-miss ghost rows must retire without commanding absent guests, or every paired device retains them. */
describe('browserTabClose on a session row with no runtime page', () => {
  it('retires the runtime-owned session row on a registry miss', async () => {
    const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
    const retireRuntimeOwnedBrowserSessionTab = vi.fn(() => true)
    const commands = new RuntimeBrowserCommands(createHost({ retireRuntimeOwnedBrowserSessionTab }))

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-ghost' })
    ).resolves.toEqual({ closed: true })
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-ghost')
  })

  it('still fails closed when no session row names that page either', async () => {
    const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
    const commands = new RuntimeBrowserCommands(
      createHost({ retireRuntimeOwnedBrowserSessionTab: vi.fn(() => false) })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-ghost' })
    ).rejects.toMatchObject({ code: 'browser_tab_not_found' })
  })

  it('retires the row even on a runtime with no browser session at all', async () => {
    const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
    const retireRuntimeOwnedBrowserSessionTab = vi.fn(() => true)
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => null as unknown as AgentBrowserBridge,
        retireRuntimeOwnedBrowserSessionTab
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-ghost' })
    ).resolves.toEqual({ closed: true })
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-ghost')
  })

  it('closes a rehydrated row with no host to ask, and leaves nothing to restore', async () => {
    const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
    const pages = new RuntimeBrowserPageRegistry()
    pages.publishClientPage({
      browserPageId: 'page-restored',
      workspaceId: 'wt-1',
      browserProfileId: 'profile-a',
      executionHostKey: 'restored-client-host-execution',
      placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
      pairedDeviceId: 'device-a',
      url: 'https://restored.internal/',
      loading: false,
      active: false
    })
    const retireRuntimeOwnedBrowserSessionTab = vi.fn(() => true)
    const commands = new RuntimeBrowserCommands(
      createHost({
        getRuntimeBrowserPageRegistry: () => pages,
        retireRuntimeOwnedBrowserSessionTab
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-restored' })
    ).resolves.toEqual({ closed: true })
    // No host lease ever existed; commanding it would strand the retained ghost row.
    expect(pages.getPage('page-restored')).toBeUndefined()
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-restored')
  })

  it('never steals a close from a page the bridge still holds', async () => {
    const { RuntimeBrowserCommands } = await import('./browser/browser-commands')
    const retireRuntimeOwnedBrowserSessionTab = vi.fn(() => true)
    const closeTab = vi.fn(async () => {})
    const commands = new RuntimeBrowserCommands(
      createHost({
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab: vi.fn(), closeTab })),
        retireRuntimeOwnedBrowserSessionTab
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-live' })
    ).resolves.toEqual({ closed: true })
    // Live guests still require destruction before ghost retirement.
    expect(closeTab).toHaveBeenCalledWith('page-live')
  })
})

// Hosts without a browser engine still own client-hosted page records.
describe('browserTabClose on a host with no browser engine', () => {
  it('retires a held client-hosted page instead of refusing with browser_unavailable', async () => {
    const { createRuntimeBrowserCommands, setRuntimeBrowserCommandsFactory } =
      await import('./runtime-browser-commands-factory')
    setRuntimeBrowserCommandsFactory(null)
    const pages = createRestoredPageRegistry()
    const retireRuntimeOwnedBrowserSessionTab = vi.fn(() => true)
    const commands = createRuntimeBrowserCommands(
      createHost({
        getRuntimeBrowserPageRegistry: () => pages,
        retireRuntimeOwnedBrowserSessionTab
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-restored' })
    ).resolves.toEqual({ closed: true })
    expect(pages.getPage('page-restored')).toBeUndefined()
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-restored')
  })

  it('retires a ghost session row, and still refuses what it cannot account for', async () => {
    const { createRuntimeBrowserCommands, setRuntimeBrowserCommandsFactory } =
      await import('./runtime-browser-commands-factory')
    setRuntimeBrowserCommandsFactory(null)
    const retireRuntimeOwnedBrowserSessionTab = vi.fn(
      (_worktreeId: string, pageId: string) => pageId === 'page-ghost'
    )
    const commands = createRuntimeBrowserCommands(
      createHost({
        retireRuntimeOwnedBrowserSessionTab,
        // Folder workspaces bypass git selectors; resolve them through browser workspace routing.
        resolveWorktreeSelector: async () => {
          throw new Error('selector_not_found')
        }
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:folder:f-1', page: 'page-ghost' })
    ).resolves.toEqual({ closed: true })
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('folder:f-1', 'page-ghost')
    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-unknown' })
    ).rejects.toMatchObject({ code: 'browser_unavailable' })
    await expect(Promise.resolve().then(() => commands.browserTabClose({}))).rejects.toMatchObject({
      code: 'browser_unavailable'
    })
  })

  it('refuses a page named under the wrong worktree', async () => {
    const { createRuntimeBrowserCommands, setRuntimeBrowserCommandsFactory } =
      await import('./runtime-browser-commands-factory')
    setRuntimeBrowserCommandsFactory(null)
    const pages = createRestoredPageRegistry()
    const commands = createRuntimeBrowserCommands(
      createHost({ getRuntimeBrowserPageRegistry: () => pages })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-2', page: 'page-restored' })
    ).rejects.toMatchObject({ code: 'browser_tab_not_found' })
    expect(pages.getPage('page-restored')).toBeDefined()
  })
})

function createRestoredPageRegistry(): RuntimeBrowserPageRegistry {
  const pages = new RuntimeBrowserPageRegistry()
  pages.publishClientPage({
    browserPageId: 'page-restored',
    workspaceId: 'wt-1',
    browserProfileId: 'profile-a',
    executionHostKey: 'restored-client-host-execution',
    placement: RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT,
    pairedDeviceId: 'device-a',
    url: 'https://restored.internal/',
    loading: false,
    active: false
  })
  return pages
}

function createHost(overrides: Partial<RuntimeBrowserCommandHost> = {}): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  const bridge =
    'getAgentBrowserBridge' in overrides
      ? overrides.getAgentBrowserBridge!()
      : ({
          getRegisteredTabs: vi.fn(() => new Map([['page-live', 100]])),
          getActivePageId: vi.fn(() => 'page-live'),
          getActiveWebContentsId: vi.fn(() => 100),
          tabList: vi.fn(() => ({ tabs: [] }))
        } as unknown as AgentBrowserBridge)
  return {
    resolveWorktreeSelector: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    resolveBrowserWorkspace: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    getBrowserHostLeaseRegistry: () => ({ getPlacement: () => undefined }),
    getAuthoritativeWindow: vi.fn(),
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null),
    ...overrides,
    getAgentBrowserBridge: () => bridge
  } as unknown as RuntimeBrowserCommandHost
}
