import { describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'
import { RESTORED_CLIENT_HOSTED_BROWSER_PLACEMENT } from './client-hosted-browser-page-persistence'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

/**
 * Closing a browser session row whose page this runtime no longer holds.
 *
 * The registry-hit branch owns a page the runtime still knows. A registry MISS used to fall through
 * to the bridge, which is keyed on live guests -- so a row left behind by a released record, or by
 * a predecessor that kept its records in memory only, answered the X with browser_tab_not_found and
 * the ghost stayed on every paired device.
 */
describe('browserTabClose on a session row with no runtime page', () => {
  it('retires the runtime-owned session row on a registry miss', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const retireRuntimeOwnedBrowserSessionTab = vi.fn(() => true)
    const commands = new RuntimeBrowserCommands(createHost({ retireRuntimeOwnedBrowserSessionTab }))

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-ghost' })
    ).resolves.toEqual({ closed: true })
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-ghost')
  })

  it('still fails closed when no session row names that page either', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const commands = new RuntimeBrowserCommands(
      createHost({ retireRuntimeOwnedBrowserSessionTab: vi.fn(() => false) })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-ghost' })
    ).rejects.toMatchObject({ code: 'browser_tab_not_found' })
  })

  it('retires the row even on a runtime with no browser session at all', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
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
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
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
    // No lease has ever held this page, so the close must not try to command an absent host --
    // that refusal is what used to strand a retained tab with no way to dismiss it.
    expect(pages.getPage('page-restored')).toBeUndefined()
    expect(retireRuntimeOwnedBrowserSessionTab).toHaveBeenCalledWith('wt-1', 'page-restored')
  })

  it('never steals a close from a page the bridge still holds', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
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
    // The guest is destroyed first; the ghost probe must not short-circuit a real close.
    expect(closeTab).toHaveBeenCalledWith('page-live')
  })
})

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
