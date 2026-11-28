import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/synthetic', on: () => {}, isPackaged: false },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  WebContentsView: class {},
  clipboard: { writeText: () => {} },
  shell: { openExternal: () => {} },
  Menu: { buildFromTemplate: () => ({}) },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {} },
  session: { fromPartition: () => ({}) },
  webContents: { fromId: () => null, getAllWebContents: () => [] }
}))
vi.mock('../../../browser/guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    cancelGrabOp: () => {},
    getGuestWebContentsId: () => undefined,
    isGrabPickedElementPresent: async () => true
  }
}))

import { RuntimeBrowserCommands } from './browser-commands'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import { setBrowserGrabMode } from '../../../browser/element-grab/browser-grab-mode-sequencer'

/** A saved tab whose guest is not mounted: any activation shows up as a start or an activate request. */
function dormantPageHost(woken: string[]): RuntimeBrowserCommandHost {
  const bridge = {
    getRegisteredPageWebContentsId: () => undefined,
    getRegisteredTabs: () => new Map(),
    getActivePageId: () => null,
    getRoutedPageId: () => null
  }
  const host = {
    getAgentBrowserBridge: () => bridge,
    getRuntimeBrowserPageRegistry: () => ({ getPage: () => undefined }),
    resolveWorkspaceSelector: async (selector: string) => ({ id: selector }),
    resolveBrowserWorkspace: async (selector: string) => ({ id: selector }),
    readBrowserTabBar: () => [{ browserPageId: 'page' }],
    getAuthoritativeWindowId: () => {
      woken.push('activate')
      return 1
    },
    serveBrowserTabs: {
      start: async (_worktree: string | undefined, page: string | undefined) => {
        woken.push(`start:${page}`)
        return new Promise<boolean>(() => {})
      },
      hasStartable: () => true,
      savedWorktreeOf: () => undefined,
      opened: () => {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: grab presence and cancel reach only the members above.
  return host as unknown as RuntimeBrowserCommandHost
}

it('answers presence for a dormant page as unknown without waking or holding it', async () => {
  const woken: string[] = []
  const commands = new RuntimeBrowserCommands(dormantPageHost(woken))
  await expect(
    commands.browserGrabPickedPresent({ page: 'page', selectionId: 'selection' })
  ).resolves.toBeNull()
  expect(woken).toEqual([])
})

it('settles the matching request held behind the page load without waiting for that load', async () => {
  const woken: string[] = []
  const commands = new RuntimeBrowserCommands(dormantPageHost(woken))
  const held = setBrowserGrabMode(
    'page',
    true,
    () => null,
    (signal) =>
      new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      ),
    { requestId: 'request' }
  )
  await expect(commands.browserGrabCancel({ page: 'page', requestId: 'request' })).resolves.toEqual(
    {
      cancelled: true
    }
  )
  await expect(held).resolves.toEqual({ ok: false, reason: 'not-ready' })
  expect(woken).toEqual([])
})
