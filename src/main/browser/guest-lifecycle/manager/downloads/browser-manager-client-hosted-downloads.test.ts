import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: browserMocks.appGetPathMock },
  BrowserWindow: { fromWebContents: browserMocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
}))

vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { browserManager } from '../browser-manager'
import {
  BrowserClientDownloadRelay,
  type BrowserClientDownloadDestination,
  type BrowserClientDownloadRouteOutcome
} from '../../../client-hosts/file-transfers/browser-client-download-relay'
import { BrowserClientFileChannelTransport } from '../../../client-hosts/file-transfers/browser-client-file-channel-transport'
import type { BrowserClientHostedPageInventory } from '../../../../../shared/browser/client-hosting/browser-client-host-protocol'
import {
  registerBrowserClientDownloadRouter,
  resetBrowserClientDownloadRouting,
  setBrowserClientRouteWebContentsProbe
} from '../../../client-hosts/file-transfers/browser-client-download-routing'
import { createBrowserClientPageGuestBinding } from '../../../client-pages/lifecycle/browser-client-page-guest-binding'
import {
  registerBrowserRouteGuestPopup,
  resetBrowserRouteGuestPopupOwnership
} from '../../../routing/guest-authority/browser-route-guest-popup-ownership'
import {
  createDownloadItem,
  getDownloadItemEventHandler,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../browser-manager-test-harness'

const GUEST_WEB_CONTENTS_ID = 6100
const SERVER_GUEST_WEB_CONTENTS_ID = 6103
const BROWSER_PAGE_ID = 'client-page-1'

describe('client-hosted downloads', () => {
  let rendererSendMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
    resetBrowserClientDownloadRouting()
    resetBrowserRouteGuestPopupOwnership()
    rendererSendMock = vi.fn()
    const guest = createGuest(GUEST_WEB_CONTENTS_ID)
    const serverGuest = createGuest(SERVER_GUEST_WEB_CONTENTS_ID)
    browserMocks.webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === GUEST_WEB_CONTENTS_ID) {
        return guest
      }
      if (id === SERVER_GUEST_WEB_CONTENTS_ID) {
        return serverGuest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })
    browserManager.attachGuestPolicies(guest as never)
    // Client-hosted pages bind in main without renderer registration.
    createBrowserClientPageGuestBinding(browserManager).bind({
      registration: {
        partition: `persist:orca-browser-v1-${'a'.repeat(64)}`,
        browserPageId: BROWSER_PAGE_ID,
        pageHostGeneration: 7,
        rendererWebContentsId,
        webContentsId: GUEST_WEB_CONTENTS_ID
      },
      browserProfileId: 'profile-a'
    })
    browserManager.attachGuestPolicies(serverGuest as never)
    browserManager.registerGuest({
      browserPageId: 'server-page-1',
      webContentsId: SERVER_GUEST_WEB_CONTENTS_ID,
      rendererWebContentsId
    })
    setBrowserClientRouteWebContentsProbe((id) => id !== SERVER_GUEST_WEB_CONTENTS_ID)
  })

  afterEach(() => {
    resetBrowserClientDownloadRouting()
    resetBrowserRouteGuestPopupOwnership()
  })

  it('aborts a download canceled while its commit is still streaming', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-client-download-')))
    const stagingRoot = path.join(root, 'downloads')
    const writes: { transferId: string; final: boolean }[] = []
    const aborts: { transferId: string }[] = []
    let releaseFirstWrite = (): void => {}
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    const transport = new BrowserClientFileChannelTransport()
    transport.bind({
      fileChannelNegotiated: true,
      fileChannelAvailability: 'negotiated',
      sendFileChannelRequest: async (method, params) => {
        if (method.endsWith('abort')) {
          aborts.push(params as { transferId: string })
          return { ok: true, result: { released: true }, _meta: {} } as never
        }
        const chunk = params as { transferId: string; final: boolean }
        writes.push(chunk)
        if (writes.length === 1) {
          await firstWrite
        }
        return {
          ok: true,
          result: chunk.final
            ? { accepted: true, workspaceRelativePath: '.orca/browser-downloads/report.csv' }
            : { accepted: true },
          _meta: {}
        } as never
      }
    })
    registerBrowserClientDownloadRouter(
      'env-a',
      new BrowserClientDownloadRelay({
        stagingRoot,
        hostLabel: 'build-box',
        transport,
        resolvePage: () => clientHostedPage
      })
    )
    const item = createDownloadItem()

    try {
      browserManager.handleGuestWillDownload({ guestWebContentsId: GUEST_WEB_CONTENTS_ID, item })
      await writeFile(savedTo(item), 'hello world')
      getDownloadItemEventHandler(item, 'once', 'done')?.({} as Electron.Event, 'completed')
      await vi.waitFor(() => expect(writes).toHaveLength(1))

      expect(
        browserManager.cancelDownload({
          downloadId: requestedDownloadId(rendererSendMock),
          senderWebContentsId: rendererWebContentsId
        })
      ).toBe(true)
      releaseFirstWrite()
      await vi.waitFor(() => expect(aborts).toHaveLength(1))

      expect(writes.map((write) => write.final)).toEqual([false])
      expect(aborts[0].transferId).toBe(writes[0].transferId)
      const finished = sentPayload(rendererSendMock, 'browser:download-finished')
      expect(finished).toMatchObject({ browserPageId: BROWSER_PAGE_ID, status: 'canceled' })
      expect(finished).not.toHaveProperty('remoteDestination')
      await vi.waitFor(async () => expect(await readdir(stagingRoot)).toEqual([]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tells chrome.downloads how an item ended only after its remote save, and lets it cancel that save', async () => {
    const commits: PromiseWithResolvers<BrowserClientDownloadDestination>[] = []
    const route = {
      transferId: 'transfer-1',
      browserPageId: BROWSER_PAGE_ID,
      stagingPath: '/staging/download',
      complete: vi.fn(() => {
        const commit = Promise.withResolvers<BrowserClientDownloadDestination>()
        commits.push(commit)
        return commit.promise
      }),
      abort: vi.fn(async () => {})
    }
    registerBrowserClientDownloadRouter('env-a', { route: () => ({ kind: 'remote', route }) })
    const startRemoteSave = async (): Promise<{
      item: Electron.DownloadItem
      onFinished: ReturnType<typeof vi.fn>
    }> => {
      const item = createDownloadItem()
      const onFinished = vi.fn()
      const commitsBefore = commits.length
      browserManager.markExtensionDownload(item, onFinished)
      browserManager.handleGuestWillDownload({ guestWebContentsId: GUEST_WEB_CONTENTS_ID, item })
      getDownloadItemEventHandler(item, 'once', 'done')?.({} as Electron.Event, 'completed')
      await vi.waitFor(() => expect(commits).toHaveLength(commitsBefore + 1))
      return { item, onFinished }
    }

    const saved = await startRemoteSave()
    expect(browserManager.tracksDownload(saved.item)).toBe(true)
    expect(saved.onFinished).not.toHaveBeenCalled()
    const destination = { workspaceRelativePath: '.orca/browser-downloads/a.csv', hostLabel: 'box' }
    commits[0].resolve(destination)
    await vi.waitFor(() => expect(saved.onFinished).toHaveBeenCalledOnce())
    expect(saved.onFinished.mock.calls[0][0]).toMatchObject({
      status: 'completed',
      remoteDestination: destination
    })

    const canceled = await startRemoteSave()
    expect(browserManager.cancelExtensionDownload(canceled.item)).toBe(true)
    expect(route.abort).toHaveBeenCalledOnce()
    expect(canceled.onFinished.mock.calls).toEqual([
      [expect.objectContaining({ status: 'canceled', error: null }), undefined, true]
    ])
    expect(browserManager.tracksDownload(canceled.item)).toBe(false)
  })

  it('tells chrome.downloads which items it is saving to the remote workspace', () => {
    const route = {
      transferId: 'transfer-1',
      browserPageId: BROWSER_PAGE_ID,
      stagingPath: '/staging/download',
      complete: vi.fn(() => new Promise<BrowserClientDownloadDestination>(() => {})),
      abort: vi.fn(async () => {})
    }
    let outcome: BrowserClientDownloadRouteOutcome = { kind: 'remote', route }
    registerBrowserClientDownloadRouter('env-a', { route: () => outcome })
    const remote = createDownloadItem()
    browserManager.handleGuestWillDownload({
      guestWebContentsId: GUEST_WEB_CONTENTS_ID,
      item: remote
    })
    outcome = { kind: 'local-fallback' }
    const fallback = createDownloadItem()
    browserManager.handleGuestWillDownload({
      guestWebContentsId: GUEST_WEB_CONTENTS_ID,
      item: fallback
    })

    expect(
      [remote, fallback, createDownloadItem()].map((item) =>
        browserManager.downloadSavesRemotely(item)
      )
    ).toEqual([true, false, false])
  })

  it('keeps telling chrome.downloads an item is remote until its failed save finishes aborting', async () => {
    const abort = Promise.withResolvers<void>()
    const route = {
      transferId: 'transfer-1',
      browserPageId: BROWSER_PAGE_ID,
      stagingPath: '/staging/download',
      complete: vi.fn(() => new Promise<BrowserClientDownloadDestination>(() => {})),
      abort: vi.fn(() => abort.promise)
    }
    registerBrowserClientDownloadRouter('env-a', { route: () => ({ kind: 'remote', route }) })
    const item = createDownloadItem()
    const onFinished = vi.fn()
    browserManager.markExtensionDownload(item, onFinished)
    browserManager.handleGuestWillDownload({ guestWebContentsId: GUEST_WEB_CONTENTS_ID, item })

    getDownloadItemEventHandler(item, 'once', 'done')?.({} as Electron.Event, 'interrupted')
    expect(route.abort).toHaveBeenCalledOnce()
    expect(browserManager.downloadSavesRemotely(item)).toBe(true)

    abort.resolve()
    await vi.waitFor(() =>
      expect(onFinished.mock.calls).toEqual([
        [expect.objectContaining({ status: 'failed' }), undefined, true]
      ])
    )
    expect(browserManager.downloadSavesRemotely(item)).toBe(false)
  })

  it('tells chrome.downloads that a shutdown, not the user, ended an item', () => {
    setBrowserClientRouteWebContentsProbe(() => false)
    const item = createDownloadItem()
    const onFinished = vi.fn()
    browserManager.markExtensionDownload(item, onFinished)
    browserManager.handleGuestWillDownload({ guestWebContentsId: GUEST_WEB_CONTENTS_ID, item })

    browserManager.unregisterAll()

    expect(onFinished.mock.calls).toEqual([
      [expect.objectContaining({ status: 'canceled' }), 'shutdown', false]
    ])
  })

  it('asks whether downloads are client-hosted for the page that owns them', () => {
    const POPUP_ID = 6200
    const EXTENSION_PAGE_ID = 6300
    setBrowserClientRouteWebContentsProbe((id) => id === GUEST_WEB_CONTENTS_ID)
    registerBrowserRouteGuestPopup({
      popupWebContentsId: POPUP_ID,
      openerWebContentsId: GUEST_WEB_CONTENTS_ID
    })
    browserManager.setUnownedDownloadOwnerResolver((id) =>
      id === EXTENSION_PAGE_ID ? BROWSER_PAGE_ID : null
    )
    try {
      expect(
        [GUEST_WEB_CONTENTS_ID, POPUP_ID, EXTENSION_PAGE_ID, SERVER_GUEST_WEB_CONTENTS_ID].map(
          (id) => browserManager.downloadRoutesToClient(id)
        )
      ).toEqual([true, true, true, false])
    } finally {
      browserManager.setUnownedDownloadOwnerResolver(() => null)
    }
  })
})

function createGuest(id: number) {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    isCurrentlyAudible: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: browserMocks.guestSetBackgroundThrottlingMock,
    setWindowOpenHandler: browserMocks.guestSetWindowOpenHandlerMock,
    on: browserMocks.guestOnMock,
    off: browserMocks.guestOffMock,
    openDevTools: browserMocks.guestOpenDevToolsMock
  }
}

const clientHostedPage: BrowserClientHostedPageInventory = Object.freeze({
  authorityRuntimeId: 'runtime-1',
  authorityEpoch: 'epoch-1',
  browserHostClientId: 'host-1',
  browserHostGeneration: 2,
  browserPageId: BROWSER_PAGE_ID,
  pageHostGeneration: 3,
  browserProfileId: 'profile-1',
  executionHostKey: 'host-key',
  state: 'active'
})

function sentPayload(send: ReturnType<typeof vi.fn>, channel: string): Record<string, unknown> {
  const call = send.mock.calls.findLast((sent: unknown[]) => sent[0] === channel)
  expect(call).toBeDefined()
  return call?.[1] as Record<string, unknown>
}

function requestedDownloadId(send: ReturnType<typeof vi.fn>): string {
  return sentPayload(send, 'browser:download-requested').downloadId as string
}

function savedTo(item: Electron.DownloadItem): string {
  const setSavePath = item.setSavePath as unknown as { mock: { calls: [string][] } }
  return setSavePath.mock.calls.at(0)?.[0] ?? ''
}
