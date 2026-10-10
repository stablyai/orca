/**
 * A server-hosted browser tab for a folder workspace (#21353). Only the client-hosted branch used
 * the folder-aware resolver, so `id:folder:…` failed with selector_not_found on the server path.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

vi.mock('../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: vi.fn(),
  waitForWorktreeTabRegistration: vi.fn()
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    getDefaultProfile: () => ({ id: 'default', partition: 'persist:orca-browser' }),
    getProfile: () => ({ id: 'default', partition: 'persist:orca-browser' }),
    resolveKnownPartition: () => 'persist:orca-browser'
  }
}))

const FOLDER = 'folder:folder-1'

function createHost(overrides: Record<string, unknown>): RuntimeBrowserCommandHost {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test host implements only the members browserTabCreate reads.
  return {
    resolveWorktreeSelector: vi.fn(async () => {
      throw new Error('selector_not_found')
    }),
    resolveBrowserWorkspace: vi.fn(async () => ({ id: FOLDER })),
    getAgentBrowserBridge: () => null,
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    ...overrides
  } as unknown as RuntimeBrowserCommandHost
}

describe('browser.tabCreate on a folder workspace', () => {
  it('creates a server-hosted page for the folder workspace', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const createTab = vi.fn(async () => ({ browserPageId: 'page-folder' }))
    const host = createHost({
      getOffscreenBrowserBackend: vi.fn(() => ({ createTab }))
    })

    await expect(
      new RuntimeBrowserCommands(host).browserTabCreate(
        { worktree: `id:${FOLDER}`, url: 'about:blank' },
        { pairedDeviceId: 'device-a', clientKind: 'runtime' }
      )
    ).resolves.toEqual({ browserPageId: 'page-folder' })

    expect(host.resolveBrowserWorkspace).toHaveBeenCalledWith(`id:${FOLDER}`)
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: FOLDER }))
  })
})
