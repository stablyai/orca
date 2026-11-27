import { expect, it, vi } from 'vitest'
import type * as PageMemory from '../../../browser/guest-lifecycle/browser-page-memory'

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
  browserManager: { cancelGrabOp: () => {}, getGuestWebContentsId: () => undefined }
}))
const sequencer = vi.hoisted(() => ({
  setBrowserGrabMode: vi.fn(async () => ({ ok: true as const, clean: false })),
  cancelBrowserGrabMode: vi.fn(() => false),
  isCurrentBrowserGrabRequest: vi.fn(() => false)
}))
vi.mock('../../../browser/element-grab/browser-grab-mode-sequencer', () => sequencer)
// Counts the page claims operations hold, so a test can see one released.
const liveClaims = vi.hoisted(() => new Map<string, number>())
vi.mock('../../../browser/guest-lifecycle/browser-page-memory', async (importOriginal) => {
  const actual = await importOriginal<typeof PageMemory>()
  return {
    ...actual,
    claimBrowserMemoryPage: (page: string, ownership?: 'agent' | 'operation') => {
      liveClaims.set(page, (liveClaims.get(page) ?? 0) + 1)
      const release = actual.claimBrowserMemoryPage(page, ownership)
      let released = false
      return () => {
        if (!released) {
          released = true
          liveClaims.set(page, (liveClaims.get(page) ?? 1) - 1)
        }
        release()
      }
    }
  }
})

import { RuntimeBrowserCommands } from './browser-commands'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

const flush = async (turns = 20): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve()
  }
}

/** A saved page whose start is held: page admission waits until `openReadiness`. */
function heldPageHost(): { host: RuntimeBrowserCommandHost; openReadiness: () => void } {
  let openReadiness: () => void = () => {}
  const started = new Promise<boolean>((resolve) => {
    openReadiness = () => resolve(true)
  })
  const bridge = {
    getRegisteredPageWebContentsId: () => undefined,
    getRegisteredTabs: () => new Map(),
    getActivePageId: () => null,
    getRoutedPageId: () => null
  }
  const members = {
    getAgentBrowserBridge: () => bridge,
    getRuntimeBrowserPageRegistry: () => ({ getPage: () => undefined }),
    resolveWorkspaceSelector: async (selector: string) => ({ id: selector }),
    readBrowserTabBar: () => [{ browserPageId: 'page' }],
    getAuthoritativeWindowId: () => 1,
    serveBrowserTabs: {
      start: () => started,
      hasStartable: () => true,
      savedWorktreeOf: () => undefined,
      opened: () => {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: page admission and grab read only the members above.
  return { host: members as unknown as RuntimeBrowserCommandHost, openReadiness }
}

it('a cancel during page admission settles the enable and releases its page claim before the page is ready', async () => {
  const { host, openReadiness } = heldPageHost()
  const commands = new RuntimeBrowserCommands(host)
  const enable = commands.browserGrabSetMode({ page: 'page', enabled: true, requestId: 'r' })
  await vi.waitFor(() => expect(liveClaims.get('page')).toBe(1))

  await expect(commands.browserGrabCancel({ page: 'page', requestId: 'r' })).resolves.toEqual({
    cancelled: true
  })
  // Settled while the page still loads, so the viewer's later input is not held behind it.
  await expect(
    Promise.race([enable, flush().then(() => 'still waiting for the page')])
  ).resolves.toEqual({ ok: false, reason: 'not-ready' })
  expect(liveClaims.get('page')).toBe(0)

  // The page's own load was not aborted; when it finishes nothing arms.
  openReadiness()
  await flush()
  expect(sequencer.setBrowserGrabMode).not.toHaveBeenCalled()
})
