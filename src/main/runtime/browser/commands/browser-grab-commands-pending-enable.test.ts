import { beforeEach, expect, it, vi } from 'vitest'

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
  // The sequencer has no owner yet while the enable waits for its page.
  cancelBrowserGrabMode: vi.fn(() => false),
  isCurrentBrowserGrabRequest: vi.fn(() => false)
}))
vi.mock('../../../browser/element-grab/browser-grab-mode-sequencer', () => sequencer)

import { RuntimeBrowserCommands } from './browser-commands'
import { RuntimeBrowserCommandTargets } from './browser-command-targets'
import { RuntimeBrowserGrab } from './browser-grab-commands'
import type { RuntimeBrowserCommandHost } from './browser-command-contracts'

const hostMembers = {
  getAgentBrowserBridge: () => null,
  getRuntimeBrowserPageRegistry: () => ({ getPage: () => undefined })
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission and grab are stubbed below; only these members are read.
const host = hostMembers as unknown as RuntimeBrowserCommandHost
type GrabGuestLookup = { resolveGrabGuest: () => Promise<unknown> }

/** Holds every page admission until `admit` runs, like a page that is still loading. */
function holdPageAdmission(): { admit: () => void } {
  let open: () => void = () => {}
  const loaded = new Promise<void>((resolve) => {
    open = resolve
  })
  vi.spyOn(RuntimeBrowserCommandTargets.prototype, 'withPageOperation').mockImplementation(
    async (params, execute) => {
      await loaded
      return execute(params)
    }
  )
  return { admit: () => open() }
}

beforeEach(() => {
  vi.restoreAllMocks()
  sequencer.setBrowserGrabMode.mockClear()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the private guest lookup is replaced; the commands call it with these params.
  const grabLookup = RuntimeBrowserGrab.prototype as unknown as GrabGuestLookup
  vi.spyOn(grabLookup, 'resolveGrabGuest').mockResolvedValue({
    browserPageId: 'page',
    resolveGuest: () => null
  })
})

it('an enable waiting for its page arms once the page is ready', async () => {
  const page = holdPageAdmission()
  const commands = new RuntimeBrowserCommands(host)
  const enable = commands.browserGrabSetMode({ page: 'page', enabled: true, requestId: 'request' })
  page.admit()
  await expect(enable).resolves.toEqual({ ok: true, clean: false })
  expect(sequencer.setBrowserGrabMode).toHaveBeenCalledTimes(1)
})

it('a cancel sent while the enable waits for its page keeps it from arming after the load', async () => {
  const page = holdPageAdmission()
  const commands = new RuntimeBrowserCommands(host)
  const enable = commands.browserGrabSetMode({ page: 'page', enabled: true, requestId: 'request' })
  await expect(commands.browserGrabCancel({ page: 'page', requestId: 'request' })).resolves.toEqual(
    { cancelled: true }
  )
  page.admit()
  await expect(enable).resolves.toEqual({ ok: false, reason: 'not-ready' })
  expect(sequencer.setBrowserGrabMode).not.toHaveBeenCalled()
})

it('a cancel for another request leaves the waiting enable to arm', async () => {
  const page = holdPageAdmission()
  const commands = new RuntimeBrowserCommands(host)
  const enable = commands.browserGrabSetMode({ page: 'page', enabled: true, requestId: 'request' })
  await expect(commands.browserGrabCancel({ page: 'page', requestId: 'other' })).resolves.toEqual({
    cancelled: false
  })
  page.admit()
  await expect(enable).resolves.toEqual({ ok: true, clean: false })
})
