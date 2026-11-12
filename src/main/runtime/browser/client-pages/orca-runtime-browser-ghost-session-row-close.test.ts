import { describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../../../browser/agent-browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

// Hosts without a browser engine still own client-hosted page records.
describe('browserTabClose on a host with no browser engine', () => {
  it('retires a held client-hosted page instead of refusing with browser_unavailable', async () => {
    const { createRuntimeBrowserCommands, setRuntimeBrowserCommandsFactory } =
      await import('../installation/runtime-browser-commands-factory')
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

  it('refuses a page named under the wrong worktree', async () => {
    const { createRuntimeBrowserCommands, setRuntimeBrowserCommandsFactory } =
      await import('../installation/runtime-browser-commands-factory')
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial host fake; these tests reach only the methods it defines.
  return {
    resolveWorkspaceSelector: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
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
