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
type GrabGuestLookup = { resolveGrabGuest: (params: { page?: string }) => Promise<unknown> }

/** Holds each page's admission separately, so one page can load before another. */
function holdEachPage(): { admit: (page: string) => void } {
  const gates = new Map<string, { opened: Promise<void>; open: () => void }>()
  const gate = (page: string) => {
    let entry = gates.get(page)
    if (!entry) {
      let open: () => void = () => {}
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      entry = { opened, open }
      gates.set(page, entry)
    }
    return entry
  }
  vi.spyOn(RuntimeBrowserCommandTargets.prototype, 'withPageOperation').mockImplementation(
    async (params, execute) => {
      await gate(params.page ?? '').opened
      return execute(params)
    }
  )
  return { admit: (page) => gate(page).open() }
}

/** The page each arming enable addressed, in order. */
const armedPages = (): unknown[] =>
  sequencer.setBrowserGrabMode.mock.calls.map((call: unknown[]) => call[0])

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
  vi.spyOn(grabLookup, 'resolveGrabGuest').mockImplementation(async (params) => ({
    browserPageId: params.page ?? 'page',
    resolveGuest: () => null
  }))
})

// Two pages pending with the same wire request ID: each cancel reaches only the page it names.
for (const [cancelledPage, survivingPage] of [
  ['page-a', 'page-b'],
  ['page-b', 'page-a']
] as const) {
  it(`same request ID on two pages: cancelling ${cancelledPage} leaves only ${survivingPage} to arm`, async () => {
    const pages = holdEachPage()
    const commands = new RuntimeBrowserCommands(host)
    const enableA = commands.browserGrabSetMode({ page: 'page-a', enabled: true, requestId: 'r' })
    const enableB = commands.browserGrabSetMode({ page: 'page-b', enabled: true, requestId: 'r' })
    await expect(
      commands.browserGrabCancel({ page: cancelledPage, requestId: 'r' })
    ).resolves.toEqual({ cancelled: true })
    const enables = { 'page-a': enableA, 'page-b': enableB }

    // The surviving page loads first, then the cancelled one.
    pages.admit(survivingPage)
    await expect(enables[survivingPage]).resolves.toEqual({ ok: true, clean: false })
    pages.admit(cancelledPage)
    await expect(enables[cancelledPage]).resolves.toEqual({ ok: false, reason: 'not-ready' })
    expect(armedPages()).toEqual([survivingPage])
  })
}

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

it('a cancel for the same request ID on another page leaves the waiting enable to arm', async () => {
  const page = holdPageAdmission()
  const commands = new RuntimeBrowserCommands(host)
  const enable = commands.browserGrabSetMode({ page: 'page', enabled: true, requestId: 'request' })
  await expect(
    commands.browserGrabCancel({ page: 'other-page', requestId: 'request' })
  ).resolves.toEqual({ cancelled: false })
  page.admit()
  await expect(enable).resolves.toEqual({ ok: true, clean: false })
  expect(sequencer.setBrowserGrabMode).toHaveBeenCalledTimes(1)
})

it('a repeated enable for a request still waiting cannot arm after that request is cancelled', async () => {
  // Each page operation waits for its own turn, so the first enable arms before the repeat is admitted.
  const turns: (() => void)[] = []
  vi.spyOn(RuntimeBrowserCommandTargets.prototype, 'withPageOperation').mockImplementation(
    async (params, execute) => {
      await new Promise<void>((resolve) => turns.push(resolve))
      return execute(params)
    }
  )
  const commands = new RuntimeBrowserCommands(host)
  const first = commands.browserGrabSetMode({ page: 'page', enabled: true, requestId: 'request' })
  const repeat = commands.browserGrabSetMode({ page: 'page', enabled: true, requestId: 'request' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  turns[0]()
  await expect(first).resolves.toEqual({ ok: true, clean: false })
  // The request is the sequencer's now; its cancel goes there, and the repeat must not arm after it.
  await commands.browserGrabCancel({ page: 'page', requestId: 'request' })
  turns[1]?.()
  await expect(repeat).resolves.toEqual({ ok: false, reason: 'not-ready' })
  expect(sequencer.setBrowserGrabMode).toHaveBeenCalledTimes(1)
})

it('a wait the viewer gave up on while its page resolved retires the armed request', async () => {
  sequencer.cancelBrowserGrabMode.mockClear()
  const commands = new RuntimeBrowserGrab(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup is stubbed in beforeEach.
    {} as unknown as ConstructorParameters<typeof RuntimeBrowserGrab>[0],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup is stubbed in beforeEach.
    {} as unknown as ConstructorParameters<typeof RuntimeBrowserGrab>[1]
  )
  const gaveUp = new AbortController()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the private guest lookup is replaced.
  vi.spyOn(commands as unknown as GrabGuestLookup, 'resolveGrabGuest').mockImplementation(
    async () => {
      gaveUp.abort()
      return { browserPageId: 'page', resolveGuest: () => null }
    }
  )
  await expect(
    commands.browserGrabAwait({ page: 'page', opId: 'op', requestId: 'request' }, gaveUp.signal)
  ).resolves.toEqual({ opId: 'op', kind: 'cancelled', reason: 'user' })
  expect(sequencer.cancelBrowserGrabMode).toHaveBeenCalledWith(
    'page',
    expect.any(Function),
    'request',
    'runtime'
  )
})

it('an enable whose viewer disconnected while it armed retires the picker it armed', async () => {
  sequencer.cancelBrowserGrabMode.mockClear()
  const disconnected = new AbortController()
  sequencer.setBrowserGrabMode.mockImplementationOnce(async () => {
    disconnected.abort()
    return { ok: true as const, clean: false }
  })
  const commands = new RuntimeBrowserCommands(host)
  vi.spyOn(RuntimeBrowserCommandTargets.prototype, 'withPageOperation').mockImplementation(
    async (params, execute) => execute(params)
  )
  await expect(
    commands.browserGrabSetMode(
      { page: 'page', enabled: true, requestId: 'request' },
      disconnected.signal
    )
  ).resolves.toEqual({ ok: false, reason: 'not-ready' })
  expect(sequencer.cancelBrowserGrabMode).toHaveBeenCalledWith(
    'page',
    expect.any(Function),
    'request',
    'runtime'
  )
})
