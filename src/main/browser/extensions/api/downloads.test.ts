import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../api-runtime/browser-extension-namespace-registry'

type ManagerFinish = (
  event: { status: 'completed' | 'canceled' | 'failed'; remoteDestination?: object },
  cause?: 'shutdown',
  routedRemotely?: boolean
) => void

const mocks = vi.hoisted(() => {
  const emitted: { event: string; args: unknown[] }[] = []
  // What the download manager reports when it ends an item it took.
  const managerFinishes = new Map<unknown, ManagerFinish>()
  return {
    emitted,
    managerFinishes,
    requestDownloadFilename: vi.fn(),
    requestDownloadSavePath: vi.fn(),
    markExtensionDownload: vi.fn((item: unknown, finish: ManagerFinish) => {
      managerFinishes.set(item, finish)
    }),
    tracksDownload: vi.fn((): boolean => false),
    downloadSavesRemotely: vi.fn((): boolean => false),
    cancelExtensionDownload: vi.fn((): boolean => false),
    downloadRoutesToClient: vi.fn((): boolean => false),
    chooseSavePath: vi.fn(async (): Promise<string | null> => null),
    showItemInFolder: vi.fn(),
    downloadsPath: ''
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => mocks.downloadsPath },
  shell: { showItemInFolder: mocks.showItemInFolder },
  webContents: { fromId: () => undefined }
}))
vi.mock('./downloads-save-as', () => ({ chooseDownloadSavePath: mocks.chooseSavePath }))
vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    getTabIdForWebContentsId: () => 'tab-1',
    requestDownloadFilename: mocks.requestDownloadFilename,
    requestDownloadSavePath: mocks.requestDownloadSavePath,
    markExtensionDownload: mocks.markExtensionDownload,
    tracksDownload: mocks.tracksDownload,
    downloadSavesRemotely: mocks.downloadSavesRemotely,
    cancelExtensionDownload: mocks.cancelExtensionDownload,
    downloadRoutesToClient: mocks.downloadRoutesToClient
  }
}))
vi.mock('../api-runtime/browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: (_target: unknown, _ns: string, event: string, args: unknown[]) =>
    mocks.emitted.push({ event, args })
}))
vi.mock('../tabs-and-windows/browser-extension-tab-model', () => ({
  getActiveBrowserTabId: () => null
}))

const { registerDownloadsNamespace } = await import('./downloads')
const { browserDownloadDestinationReservations } =
  await import('../../downloads/browser-download-destination')
const { getBrowserExtensionNamespace } =
  await import('../api-runtime/browser-extension-namespace-registry')

const EXTENSION_ID = 'a'.repeat(32)
const OTHER_ID = 'b'.repeat(32)
const sessions = new Set<Electron.Session>()
const pendingDownloads: Promise<unknown>[] = []
let nextOwnerId = 7

const { ensureHostSessionState, forgetHostSession, forgetExtensionContexts } =
  await import('../api-runtime/browser-extension-contexts')

function fakeItem(url: string, savePath: string, finalUrl = url) {
  return {
    getURL: () => finalUrl,
    getURLChain: () => (finalUrl === url ? [url] : [url, finalUrl]),
    getState: () => 'progressing',
    getSavePath: () => savePath,
    getMimeType: () => '',
    getStartTime: () => 0,
    isPaused: () => false,
    canResume: () => false,
    getReceivedBytes: () => 0,
    getTotalBytes: () => 0,
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn()
  }
}

function setup() {
  const session = new EventEmitter()
  const owner = { id: nextOwnerId++, isDestroyed: () => false, downloadURL: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: downloads and context lifetime read only these stubbed caller fields.
  const caller = {
    extension: { id: EXTENSION_ID },
    session,
    webContents: owner
  } as unknown as BrowserExtensionCaller
  ensureHostSessionState(caller.session, 'default')
  sessions.add(caller.session)
  const download = (
    options: Record<string, unknown>,
    extensionId = EXTENSION_ID
  ): Promise<unknown> => {
    const pending = Promise.resolve().then(() =>
      getBrowserExtensionNamespace('downloads')?.methods.download.invoke(
        { ...caller, extension: { ...caller.extension, id: extensionId } },
        [options]
      )
    )
    pendingDownloads.push(pending)
    void pending.catch(() => {})
    return pending
  }
  // What Electron's will-download event records: whether a listener refused the item.
  const willDownload = (item: ReturnType<typeof fakeItem> | FakeDownloadItem) => {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    session.emit('will-download', event, item, owner)
    return event
  }
  const call = (
    method: string,
    args: unknown[],
    extension: Partial<Electron.Extension> = {}
  ): Promise<unknown> =>
    Promise.resolve().then(() =>
      getBrowserExtensionNamespace('downloads')?.methods[method]?.invoke(
        { ...caller, extension: { ...caller.extension, ...extension } },
        args
      )
    )
  return { session: caller.session, owner, download, willDownload, call }
}

class FakeDownloadItem extends EventEmitter {
  private state = 'progressing'
  private savePath = ''
  private bytes = 0
  private resumable = false
  readonly cancel = vi.fn(() => {
    if (this.state === 'progressing' || this.resumable) {
      this.state = 'cancelled'
      this.resumable = false
      this.emit('done', {}, 'cancelled')
    }
  })

  constructor(private readonly url: string) {
    super()
  }

  getURL = (): string => this.url
  getURLChain = (): string[] => [this.url]
  getState = (): string => this.state
  getSavePath = (): string => this.savePath
  setSavePath = (savePath: string): void => {
    this.savePath = savePath
  }
  getMimeType = (): string => 'application/octet-stream'
  getStartTime = (): number => 1_700_000_000
  isPaused = (): boolean => false
  canResume = (): boolean => this.resumable
  getReceivedBytes = (): number => this.bytes
  getTotalBytes = (): number => this.bytes

  /** What Electron does: writes the bytes at the save path, then reports done. */
  complete(contents: string, transferred = Buffer.byteLength(contents)): void {
    writeFileSync(this.savePath, contents)
    this.bytes = transferred
    this.state = 'completed'
    this.emit('done', {}, 'completed')
  }

  /** A resumable network failure: Electron reports an update and waits for a resume. */
  interrupt(): void {
    this.state = 'interrupted'
    this.resumable = true
    this.emit('updated', {}, 'interrupted')
  }

  /** A network failure: Electron reports done as interrupted, with no cancel. */
  fail(): void {
    this.state = 'interrupted'
    this.emit('done', {}, 'interrupted')
  }
}

function retireContext(session: Electron.Session, kind: 'extension' | 'host'): void {
  if (kind === 'host') {
    forgetHostSession(session)
    ensureHostSessionState(session, 'default')
  } else {
    forgetExtensionContexts(session, EXTENSION_ID)
  }
}

beforeEach(() => {
  mocks.emitted.length = 0
  mocks.requestDownloadFilename.mockReset()
  mocks.requestDownloadSavePath.mockReset()
  mocks.chooseSavePath.mockReset()
  mocks.downloadRoutesToClient.mockReset().mockReturnValue(false)
  mocks.managerFinishes.clear()
  mocks.tracksDownload.mockReset().mockReturnValue(false)
  mocks.downloadSavesRemotely.mockReset().mockReturnValue(false)
  mocks.cancelExtensionDownload.mockReset().mockReturnValue(false)
  registerDownloadsNamespace()
})

afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runAllTimersAsync()
    vi.useRealTimers()
  }
  await Promise.allSettled(pendingDownloads.splice(0))
  for (const session of sessions) {
    forgetHostSession(session)
  }
  sessions.clear()
})

describe('download context lifetime', () => {
  beforeEach(() => vi.useFakeTimers())

  it.each(['extension', 'host'] as const)(
    'skips obsolete starts after %s retirement without releasing the active native start',
    async (kind) => {
      const { session, owner, download, willDownload } = setup()
      const url = 'https://site.test/serialized'
      const first = download({ url, filename: 'active.txt' })
      const obsolete = [
        download({ url, filename: 'obsolete-1.txt' }),
        download({ url, filename: 'obsolete-2.txt' })
      ]
      let obsoleteResults: PromiseSettledResult<unknown>[] | undefined
      void Promise.allSettled(obsolete).then((results) => {
        obsoleteResults = results
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.downloadURL).toHaveBeenCalledTimes(1)
      retireContext(session, kind)
      const successor = download({ url, filename: 'successor.txt' })
      const sibling = download({ url, filename: 'sibling.txt' }, OTHER_ID)
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.downloadURL).toHaveBeenCalledTimes(1)
      expect(session.listenerCount('will-download')).toBe(1)
      expect(vi.getTimerCount()).toBe(1)

      const activeItem = fakeItem(url, '/downloads/active.txt')
      willDownload(activeItem)
      await expect(first).resolves.toEqual(expect.any(Number))
      await vi.advanceTimersByTimeAsync(0)
      expect(obsoleteResults).toEqual([
        {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'Extension context was unloaded' })
        },
        {
          status: 'rejected',
          reason: expect.objectContaining({ message: 'Extension context was unloaded' })
        }
      ])
      expect(owner.downloadURL).toHaveBeenCalledTimes(2)
      expect(mocks.requestDownloadFilename).toHaveBeenCalledExactlyOnceWith(
        activeItem,
        'active.txt'
      )
      const successorItem = fakeItem(url, '/downloads/successor.txt')
      willDownload(successorItem)
      await expect(successor).resolves.toEqual(expect.any(Number))
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.downloadURL).toHaveBeenCalledTimes(3)
      const siblingItem = fakeItem(url, '/downloads/sibling.txt')
      willDownload(siblingItem)
      await expect(sibling).resolves.toEqual(expect.any(Number))
      expect(mocks.requestDownloadFilename.mock.calls.map(([, name]) => name)).toEqual([
        'active.txt',
        'successor.txt',
        'sibling.txt'
      ])
      expect(session.listenerCount('will-download')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['extension', 'host'] as const)(
    'rejects a late save dialog result after %s retirement before waiting behind a live start',
    async (kind) => {
      const { session, owner, download, willDownload } = setup()
      const dialog = Promise.withResolvers<string | null>()
      mocks.chooseSavePath.mockReturnValueOnce(dialog.promise)
      const url = 'https://site.test/save-as'
      const old = download({ url, saveAs: true })
      let oldSettled = false
      void old
        .finally(() => {
          oldSettled = true
        })
        .catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.chooseSavePath).toHaveBeenCalledOnce()
      retireContext(session, kind)
      const successor = download({ url, filename: 'live.txt' })
      await vi.advanceTimersByTimeAsync(0)
      expect(owner.downloadURL).toHaveBeenCalledTimes(1)
      dialog.resolve('/downloads/obsolete.txt')
      await vi.advanceTimersByTimeAsync(0)
      expect(oldSettled).toBe(true)
      await expect(old).rejects.toThrow('Extension context was unloaded')
      expect(owner.downloadURL).toHaveBeenCalledTimes(1)
      expect(mocks.requestDownloadSavePath).not.toHaveBeenCalled()
      willDownload(fakeItem(url, '/downloads/live.txt'))
      await expect(successor).resolves.toEqual(expect.any(Number))
      expect(session.listenerCount('will-download')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('skips obsolete starts after the admitted predecessor times out', async () => {
    const { session, owner, download, willDownload } = setup()
    const url = 'https://site.test/timeout'
    const first = download({ url })
    const obsolete = download({ url })
    let obsoleteResult: unknown
    void obsolete.catch((error: unknown) => {
      obsoleteResult = error
    })
    await vi.advanceTimersByTimeAsync(0)
    retireContext(session, 'extension')
    const successor = download({ url })
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(first).rejects.toThrow('The download did not start')
    expect(obsoleteResult).toEqual(
      expect.objectContaining({ message: 'Extension context was unloaded' })
    )
    await expect(obsolete).rejects.toThrow('Extension context was unloaded')
    expect(owner.downloadURL).toHaveBeenCalledTimes(2)
    expect(session.listenerCount('will-download')).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    willDownload(fakeItem(url, '/downloads/live.txt'))
    await expect(successor).resolves.toEqual(expect.any(Number))
    expect(session.listenerCount('will-download')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('download records', () => {
  const JOURNAL = 'App/s1/parts/part-0001.jsonl'

  const overwrite = (url: string, filename: string) => ({
    url,
    filename,
    conflictAction: 'overwrite'
  })

  // Why wait on downloadURL: reserving an overwrite awaits the disk, which fake timers cannot flush.
  async function downloadURLCalled(context: ReturnType<typeof setup>, times = 1): Promise<void> {
    await vi.waitFor(() => expect(context.owner.downloadURL).toHaveBeenCalledTimes(times))
  }

  beforeEach(() => {
    mocks.downloadsPath = mkdtempSync(join(tmpdir(), 'orca-extension-downloads-'))
    mocks.showItemInFolder.mockReset()
    // The manager saves a chosen path verbatim.
    mocks.requestDownloadSavePath.mockImplementation((item: FakeDownloadItem, savePath: string) =>
      item.setSavePath(savePath)
    )
  })

  afterEach(() => {
    rmSync(mocks.downloadsPath, { recursive: true, force: true })
  })

  async function startJournalPart(
    context: ReturnType<typeof setup>,
    url: string,
    filename = JOURNAL
  ): Promise<{ id: unknown; item: FakeDownloadItem }> {
    const starts = context.owner.downloadURL.mock.calls.length
    const started = context.download({ ...overwrite(url, filename), saveAs: false })
    await downloadURLCalled(context, starts + 1)
    const item = new FakeDownloadItem(url)
    context.willDownload(item)
    return { id: await started, item }
  }

  it('overwrites a nested journal part, reports it from disk, and erases only the record', async () => {
    const context = setup()
    const target = join(mocks.downloadsPath, 'App', 's1', 'parts', 'part-0001.jsonl')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'old')

    const first = await startJournalPart(context, 'data:application/octet-stream;base64,MQ==')
    expect(mocks.emitted).toEqual([
      { event: 'onCreated', args: [expect.objectContaining({ id: first.id, exists: true })] }
    ])
    first.item.complete('{"n":1}\n')

    const second = await startJournalPart(context, 'data:application/octet-stream;base64,Mw==')
    // A compressed transfer: fewer bytes arrive than the file holds.
    second.item.complete('{"n":1}\n{"n":2}\n', 12)
    expect(await context.call('search', [{ id: second.id }])).toEqual([
      expect.objectContaining({
        id: second.id,
        state: 'complete',
        filename: target,
        exists: true,
        bytesReceived: 12,
        totalBytes: 12,
        fileSize: 16
      })
    ])

    mocks.showItemInFolder.mockImplementationOnce(() => {
      throw new Error('No file manager')
    })
    await expect(context.call('show', [second.id])).resolves.toBeUndefined()
    expect(mocks.showItemInFolder).toHaveBeenCalledExactlyOnceWith(target)

    mocks.emitted.length = 0
    expect(await context.call('erase', [{ id: second.id }])).toEqual([second.id])
    expect(await context.call('erase', [{ id: second.id }])).toEqual([])
    expect(mocks.emitted).toEqual([{ event: 'onErased', args: [second.id] }])
    expect(await context.call('search', [{ id: second.id }])).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe('{"n":1}\n{"n":2}\n')
  })

  it('reports a later file removal without revealing it', async () => {
    const context = setup()
    const { id, item } = await startJournalPart(context, 'data:text/plain,hi')
    item.complete('hi')
    rmSync(join(mocks.downloadsPath, 'App'), { recursive: true })

    expect(await context.call('search', [{ id }])).toEqual([
      expect.objectContaining({ id, state: 'complete', exists: false, fileSize: 2 })
    ])
    await expect(context.call('show', [id])).resolves.toBeUndefined()
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  it('lets only the starting extension in its profile see, cancel or erase a download', async () => {
    const mine = setup()
    const otherProfile = setup()
    const { id, item } = await startJournalPart(mine, 'data:text/plain,partial')

    expect(await mine.call('search', [{}], { id: OTHER_ID })).toEqual([])
    expect(await otherProfile.call('search', [{ id }])).toEqual([])
    await mine.call('cancel', [id], { id: OTHER_ID })
    await otherProfile.call('cancel', [id])
    expect(await mine.call('erase', [{ id }], { id: OTHER_ID })).toEqual([])
    expect(item.cancel).not.toHaveBeenCalled()
    await expect(mine.call('erase', [{ id }])).rejects.toThrow(
      'Cancel in-progress downloads before erasing them'
    )

    await mine.call('cancel', [id])
    expect(await mine.call('search', [{ id }])).toEqual([
      expect.objectContaining({ id, state: 'interrupted', error: 'USER_CANCELED' })
    ])
    // As in Chrome, cancelling a finished or unknown id does nothing.
    await expect(mine.call('cancel', [id])).resolves.toBeUndefined()
    await expect(mine.call('cancel', [Number.MAX_SAFE_INTEGER])).resolves.toBeUndefined()
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(mocks.emitted.filter(({ event }) => event === 'onChanged')).toEqual([
      {
        event: 'onChanged',
        args: [
          {
            id,
            state: { previous: 'in_progress', current: 'interrupted' },
            error: { current: 'USER_CANCELED' }
          }
        ]
      }
    ])
  })

  it('accepts setUiOptions only with the downloads.ui permission', async () => {
    const context = setup()
    const uiPermission = { manifest: { permissions: ['downloads', 'downloads.ui'] } }
    await expect(context.call('setUiOptions', [{ enabled: true }])).rejects.toThrow(
      'downloads.setUiOptions requires the "downloads.ui" permission'
    )
    await expect(
      context.call('setUiOptions', [{ enabled: true }], uiPermission)
    ).resolves.toBeUndefined()
  })

  it('filters by state, url and filename and limits results in creation order', async () => {
    const context = setup()
    const ids = async (query: Record<string, unknown>): Promise<unknown> => {
      const found: unknown = await context.call('search', [query])
      return Array.isArray(found) ? found.map(({ id }: { id: unknown }) => id) : found
    }
    const done = await startJournalPart(context, 'data:text/plain,done', 'App/done.txt')
    const failed = await startJournalPart(context, 'data:text/plain,failed', 'App/failed.txt')
    const running = await startJournalPart(context, 'data:text/plain,running', 'App/running.txt')
    done.item.complete('done')
    failed.item.fail()

    expect(await ids({ limit: 2 })).toEqual([done.id, failed.id])
    expect(await ids({ limit: 0 })).toEqual([done.id, failed.id, running.id])
    expect(await ids({ state: 'complete' })).toEqual([done.id])
    expect(await ids({ state: 'interrupted' })).toEqual([failed.id])
    expect(await ids({ state: 'in_progress' })).toEqual([running.id])
    expect(await ids({ url: 'data:text/plain,failed' })).toEqual([failed.id])
    expect(await ids({ filename: join(mocks.downloadsPath, 'App', 'running.txt') })).toEqual([
      running.id
    ])
    running.item.complete('running')
  })

  it('filters on the state the item reports at search time', async () => {
    const context = setup()
    const url = 'data:text/plain,stale'
    const started = context.download({ url, filename: 'stale.txt' })
    await vi.waitFor(() => expect(context.owner.downloadURL).toHaveBeenCalledOnce())
    const item = fakeItem(url, join(mocks.downloadsPath, 'stale.txt'))
    context.willDownload(item)
    const id = await started
    item.getState = () => 'interrupted'

    expect(await context.call('search', [{ state: 'in_progress' }])).toEqual([])
    expect(await context.call('search', [{ state: 'interrupted' }])).toEqual([
      expect.objectContaining({ id, state: 'interrupted' })
    ])
  })

  it('reports -1 sizes while the total is unknown', async () => {
    const context = setup()
    const { id } = await startJournalPart(context, 'data:text/plain,size')
    expect(await context.call('search', [{ id }])).toEqual([
      expect.objectContaining({ state: 'in_progress', totalBytes: -1, fileSize: -1 })
    ])
  })

  it('reports an interruption that Orca then cancels as NETWORK_FAILED, not a user cancel', async () => {
    const context = setup()
    mocks.tracksDownload.mockReturnValue(true)
    const { id, item } = await startJournalPart(context, 'data:text/plain,network')
    item.interrupt()
    // What the manager does with an interruption: Orca offers no resume, so it cancels the item.
    item.cancel()
    mocks.managerFinishes.get(item)?.({ status: 'failed' })

    expect(await context.call('search', [{ id }])).toEqual([
      expect.objectContaining({ id, state: 'interrupted', error: 'NETWORK_FAILED' })
    ])
    expect(mocks.emitted.filter(({ event }) => event === 'onChanged')).toEqual([
      {
        event: 'onChanged',
        args: [
          {
            id,
            state: { previous: 'in_progress', current: 'interrupted' },
            error: { current: 'NETWORK_FAILED' }
          }
        ]
      }
    ])
  })

  it('on a client-hosted page, hands a nested name over as main did without touching Downloads, and refuses overwrite', async () => {
    const context = setup()
    mocks.downloadRoutesToClient.mockReturnValue(true)
    await expect(
      context.download(overwrite('data:text/plain,overwrite', 'COMPLETE.json'))
    ).rejects.toThrow('A remote workspace cannot overwrite a file; use conflictAction "uniquify"')
    expect(context.owner.downloadURL).not.toHaveBeenCalled()

    const url = 'data:text/plain,nested'
    const started = context.download({ url, filename: JOURNAL })
    await vi.waitFor(() => expect(context.owner.downloadURL).toHaveBeenCalledOnce())
    const item = new FakeDownloadItem(url)
    context.willDownload(item)
    await expect(started).resolves.toEqual(expect.any(Number))
    expect(mocks.requestDownloadFilename).toHaveBeenCalledExactlyOnceWith(item, JOURNAL)
    expect(mocks.requestDownloadSavePath).not.toHaveBeenCalled()
    expect(existsSync(join(mocks.downloadsPath, 'App'))).toBe(false)
  })

  describe('items the download manager ends', () => {
    async function startPlain(
      context: ReturnType<typeof setup>,
      url: string,
      savePath = join(mocks.downloadsPath, 'staging-download')
    ) {
      const starts = context.owner.downloadURL.mock.calls.length
      const started = context.download({ url, filename: 'notes.txt' })
      await vi.waitFor(() => expect(context.owner.downloadURL).toHaveBeenCalledTimes(starts + 1))
      const item = new FakeDownloadItem(url)
      item.setSavePath(savePath)
      context.willDownload(item)
      return { id: await started, item }
    }

    it('settles a remote save only when the manager ends it: failed, or saved with no local file facts', async () => {
      const context = setup()
      mocks.tracksDownload.mockReturnValue(true)
      const failed = await startPlain(context, 'data:text/plain,failed')
      failed.item.complete('staged')
      expect(await context.call('search', [{ id: failed.id }])).toEqual([
        expect.objectContaining({ state: 'in_progress' })
      ])
      mocks.managerFinishes.get(failed.item)?.({ status: 'failed' }, undefined, true)
      expect(await context.call('search', [{ id: failed.id }])).toEqual([
        expect.objectContaining({ state: 'interrupted', error: 'FILE_FAILED' })
      ])

      const saved = await startPlain(context, 'data:text/plain,saved')
      saved.item.complete('staged')
      // The relay deletes the staged copy once the remote workspace has it.
      rmSync(saved.item.getSavePath())
      mocks.managerFinishes.get(saved.item)?.(
        {
          status: 'completed',
          remoteDestination: { workspaceRelativePath: '.orca/browser-downloads/notes.txt' }
        },
        undefined,
        true
      )
      expect(await context.call('search', [{ id: saved.id }])).toEqual([
        expect.objectContaining({ state: 'complete', exists: true, fileSize: 6 })
      ])
    })

    it('reports a remote save in progress as main will, not from its staging file', async () => {
      const context = setup()
      mocks.downloadRoutesToClient.mockReturnValue(true)
      mocks.tracksDownload.mockReturnValue(true)
      mocks.downloadSavesRemotely.mockReturnValue(true)
      // Electron has not written the staged copy yet.
      const { id } = await startPlain(context, 'data:text/plain,remote')
      expect(await context.call('search', [{ id }])).toEqual([
        expect.objectContaining({ state: 'in_progress', exists: true })
      ])
    })

    it("never reveals a remote save's staging file, yet reveals a local-fallback save", async () => {
      const context = setup()
      mocks.downloadRoutesToClient.mockReturnValue(true)
      mocks.tracksDownload.mockReturnValue(true)
      mocks.downloadSavesRemotely.mockReturnValue(true)
      const remote = await startPlain(context, 'data:text/plain,remote')
      remote.item.complete('staged')
      await context.call('show', [remote.id])
      // The staged copy stays behind if the relay fails to delete it.
      mocks.managerFinishes.get(remote.item)?.(
        {
          status: 'completed',
          remoteDestination: { workspaceRelativePath: '.orca/browser-downloads/notes.txt' }
        },
        undefined,
        true
      )
      await context.call('show', [remote.id])
      expect(mocks.showItemInFolder).not.toHaveBeenCalled()

      // A legacy host without the file channel: the manager saves to local Downloads.
      mocks.downloadSavesRemotely.mockReturnValue(false)
      const local = join(mocks.downloadsPath, 'notes.txt')
      const fallback = await startPlain(context, 'data:text/plain,fallback', local)
      fallback.item.complete('saved')
      await context.call('show', [fallback.id])
      expect(mocks.showItemInFolder).toHaveBeenCalledExactlyOnceWith(local)
    })

    it('reports a canceled or failed remote save as gone and never reveals its staging file', async () => {
      const context = setup()
      mocks.downloadRoutesToClient.mockReturnValue(true)
      mocks.tracksDownload.mockReturnValue(true)
      mocks.downloadSavesRemotely.mockReturnValue(true)
      for (const status of ['canceled', 'failed'] as const) {
        const { id, item } = await startPlain(context, `data:text/plain,${status}`)
        item.complete('staged')
        // The staged copy is still on disk when the manager reports the outcome.
        mocks.managerFinishes.get(item)?.({ status }, undefined, true)
        expect(await context.call('search', [{ id }])).toEqual([
          expect.objectContaining({ state: 'interrupted', exists: false })
        ])
        await context.call('show', [id])
      }
      expect(mocks.showItemInFolder).not.toHaveBeenCalled()
    })

    it('cancels a remote save in progress through the manager', async () => {
      const context = setup()
      mocks.tracksDownload.mockReturnValue(true)
      const { id, item } = await startPlain(context, 'data:text/plain,cancel')
      item.complete('staged')
      mocks.cancelExtensionDownload.mockImplementation(() => {
        mocks.managerFinishes.get(item)?.({ status: 'canceled' }, undefined, true)
        return true
      })
      void context.call('cancel', [id])

      await vi.waitFor(async () =>
        expect(await context.call('search', [{ id }])).toEqual([
          expect.objectContaining({ state: 'interrupted', error: 'USER_CANCELED' })
        ])
      )
    })

    it('settles once, with Chrome reasons, an item the manager ends inside will-download or at shutdown', async () => {
      const context = setup()
      // What the manager does for a blocked route or a failed setSavePath: it finishes, then cancels.
      const failInside = (_event: Electron.Event, item: Electron.DownloadItem): void => {
        mocks.managerFinishes.get(item)?.({ status: 'failed' })
        item.cancel()
      }
      context.session.on('will-download', failInside)
      const blocked = await startPlain(context, 'data:text/plain,blocked')
      context.session.off('will-download', failInside)
      const stopped = await startPlain(context, 'data:text/plain,shutdown')
      mocks.managerFinishes.get(stopped.item)?.({ status: 'canceled' }, 'shutdown')

      expect(await context.call('search', [{}])).toEqual([
        expect.objectContaining({ id: blocked.id, state: 'interrupted', error: 'FILE_FAILED' }),
        expect.objectContaining({ id: stopped.id, state: 'interrupted', error: 'USER_SHUTDOWN' })
      ])
      expect(mocks.emitted.filter(({ event }) => event === 'onChanged')).toEqual([
        { event: 'onChanged', args: [expect.objectContaining({ id: blocked.id })] },
        { event: 'onChanged', args: [expect.objectContaining({ id: stopped.id })] }
      ])
    })
  })

  describe('overwrite starts that never save', () => {
    beforeEach(() => vi.useFakeTimers())

    async function expectOverwriteStarts(
      context: ReturnType<typeof setup>,
      url: string,
      filename: string
    ): Promise<void> {
      const starts = context.owner.downloadURL.mock.calls.length
      const started = context.download(overwrite(url, filename))
      await downloadURLCalled(context, starts + 1)
      context.willDownload(new FakeDownloadItem(url))
      await expect(started).resolves.toEqual(expect.any(Number))
    }

    it('frees the path of a queued start skipped after retirement', async () => {
      const context = setup()
      const url = 'data:text/plain,queued'
      const active = context.download(overwrite(url, 'App/active.txt'))
      const queued = context.download(overwrite(url, 'App/queued.txt'))
      await downloadURLCalled(context)
      retireContext(context.session, 'extension')
      const activeItem = new FakeDownloadItem(url)
      context.willDownload(activeItem)
      await expect(active).resolves.toEqual(expect.any(Number))
      await expect(queued).rejects.toThrow('Extension context was unloaded')
      activeItem.complete('active')

      await expectOverwriteStarts(context, 'data:text/plain,successor', 'App/queued.txt')
    })

    it('frees the path of a start that timed out', async () => {
      const context = setup()
      const stuck = context.download(overwrite('data:text/plain,stuck', 'App/stuck.txt'))
      await downloadURLCalled(context)
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(stuck).rejects.toThrow('The download did not start')

      await expectOverwriteStarts(context, 'data:text/plain,retry', 'App/stuck.txt')
    })

    it('frees the path of a start whose tab is gone when downloadURL runs', async () => {
      const context = setup()
      context.owner.downloadURL.mockImplementationOnce(() => {
        throw new Error('Object has been destroyed')
      })
      await expect(
        context.download(overwrite('data:text/plain,gone', 'App/gone.txt'))
      ).rejects.toThrow('The download did not start')

      await expectOverwriteStarts(context, 'data:text/plain,again', 'App/gone.txt')
    })

    it('frees the path of a start that a later will-download listener refuses', async () => {
      const context = setup()
      const refuse = (event: Electron.Event): void => event.preventDefault()
      context.session.on('will-download', refuse)
      const url = 'data:text/plain,refused'
      const refused = context.download(overwrite(url, 'App/refused.txt'))
      await downloadURLCalled(context)
      // Electron gives no done for a refused item; it destroys the item on the next tick.
      context.willDownload(new FakeDownloadItem(url))
      const id = await refused
      context.session.off('will-download', refuse)

      expect(await context.call('search', [{ id }])).toEqual([
        expect.objectContaining({ id, state: 'interrupted', error: 'FILE_BLOCKED' })
      ])
      await expectOverwriteStarts(context, 'data:text/plain,after', 'App/refused.txt')
    })

    it("keeps a later start's file when a start that a reset cleared times out", async () => {
      const stale = setup()
      const stuck = stale.download(overwrite('data:text/plain,stale', 'App/same.txt'))
      await downloadURLCalled(stale)
      // What closing the window does while this start still waits for will-download.
      browserDownloadDestinationReservations.clear()
      await expectOverwriteStarts(setup(), 'data:text/plain,later', 'App/same.txt')
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(stuck).rejects.toThrow('The download did not start')

      await expect(
        setup().download(overwrite('data:text/plain,third', 'App/same.txt'))
      ).rejects.toThrow('Another download is already saving to this file.')
    })

    it('drops a start whose reservation a reset cleared before will-download', async () => {
      const context = setup()
      const url = 'data:text/plain,reset'
      const dropped = context.download(overwrite(url, 'App/reset.txt'))
      await downloadURLCalled(context)
      browserDownloadDestinationReservations.clear()
      const item = new FakeDownloadItem(url)
      const event = context.willDownload(item)

      await expect(dropped).rejects.toThrow('Downloads were reset before the download started')
      // What makes the manager's listener skip the item; Electron then drops it.
      expect(event.defaultPrevented).toBe(true)
      expect(mocks.requestDownloadSavePath).not.toHaveBeenCalled()
      expect(mocks.managerFinishes.has(item)).toBe(false)
      expect(mocks.emitted).toEqual([])
    })

    it.each([
      {
        stop: 'the extension context unloads',
        end: (context: ReturnType<typeof setup>) => retireContext(context.session, 'extension'),
        error: 'Extension context was unloaded'
      },
      {
        stop: 'the tab closes',
        end: (context: ReturnType<typeof setup>) => {
          context.owner.isDestroyed = () => true
        },
        error: 'The tab closed before the download started'
      }
    ])(
      'frees the path of a start when $stop while its file is reserved',
      async ({ end, error }) => {
        const context = setup()
        const reserve = browserDownloadDestinationReservations.reserveTarget.bind(
          browserDownloadDestinationReservations
        )
        const gate = Promise.withResolvers<void>()
        const reserving = vi
          .spyOn(browserDownloadDestinationReservations, 'reserveTarget')
          .mockImplementationOnce(async (...args) => {
            await gate.promise
            return reserve(...args)
          })
        onTestFinished(() => reserving.mockRestore())
        const stopped = context.download(overwrite('data:text/plain,stopped', 'App/stopped.txt'))
        await vi.waitFor(() => expect(reserving).toHaveBeenCalledOnce())
        end(context)
        gate.resolve()

        await expect(stopped).rejects.toThrow(error)
        expect(context.owner.downloadURL).not.toHaveBeenCalled()
        await expectOverwriteStarts(setup(), 'data:text/plain,next', 'App/stopped.txt')
      }
    )
  })
})

describe('download options', () => {
  it('rejects prompt without saveAs and overwrite without a filename before starting', async () => {
    const { owner, download } = setup()
    await expect(
      download({ url: 'https://site.test/a', conflictAction: 'prompt' })
    ).rejects.toThrow('Orca saves downloads only with conflictAction "uniquify" or "overwrite"')
    await expect(
      download({ url: 'https://site.test/a', conflictAction: 'overwrite' })
    ).rejects.toThrow('Orca overwrites only a file named by "filename"')
    expect(owner.downloadURL).not.toHaveBeenCalled()
  })
})
