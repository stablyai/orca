import { webContents as allWebContents } from 'electron'
import { z } from 'zod'
import {
  getChromeExtensionOrigin,
  parseChromeExtensionUrl
} from '../../../../shared/browser/extensions/browser-extension-url'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import {
  browserDownloadDestinationReservations,
  type BrowserDownloadTargetDestination
} from '../../downloads/browser-download-destination'
import { getBrowserExtensionContextSignal } from '../api-runtime/browser-extension-context-lifetime'
import { getHostSessionState } from '../api-runtime/browser-extension-contexts'
import { chooseDownloadSavePath } from './downloads-save-as'
import {
  requestedPlace,
  requireDownloadContext,
  reserveTarget,
  type DownloadPlace
} from './downloads-place'
import {
  cancelDownload,
  downloadQuerySchema,
  emitDownloadsEvent,
  eraseDownloads,
  searchDownloads,
  showDownload
} from './downloads-history'
import {
  createDownloadRecord,
  describeDownloadRecord,
  downloadRecordDelta,
  finishedDownloadError,
  noteDownloadUpdate,
  requestedUrl,
  settleDownloadRecord,
  type ChromeDownloadError
} from './downloads-records'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  extensionHasPermission,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import { getActiveBrowserTabId } from '../tabs-and-windows/browser-extension-tab-model'

const WILL_DOWNLOAD_TIMEOUT_MS = 15_000
type DoneState = 'completed' | 'cancelled' | 'interrupted'
let nextDownloadId = 1
/** Owner + URL → the start in flight; will-download names no caller, so identical starts take turns. */
const startsInFlight = new Map<string, Promise<unknown>>()

const optionsSchema = z
  .object({
    url: z.string().min(1),
    filename: z.string(),
    saveAs: z.boolean(),
    method: z.enum(['GET', 'POST']),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
    body: z.string(),
    conflictAction: z.enum(['uniquify', 'overwrite', 'prompt'])
  })
  .partial()
  .required({ url: true })
  .loose()

/** Why a tab: Orca's download UI belongs to a page, so a worker's download lands on the active tab. */
function downloadOwner(caller: BrowserExtensionCaller, url: string): Electron.WebContents {
  const own = caller.webContents
  // Why blob: a page's blob URL resolves only in the renderer that created it.
  const ownsBlob = url.startsWith('blob:')
  if (own && !own.isDestroyed() && (ownsBlob || browserManager.getTabIdForWebContentsId(own.id))) {
    return own
  }
  const activeId = getActiveBrowserTabId()
  const active = activeId === null ? undefined : allWebContents.fromId(activeId)
  if (active && !active.isDestroyed() && active.session === caller.session) {
    return active
  }
  throw new BrowserExtensionApiError('Open a browser tab to download into')
}

function resolveDownloadUrl(caller: BrowserExtensionCaller, raw: string): string {
  const origin = getChromeExtensionOrigin(caller.extension.id)
  let url: URL
  try {
    url = new URL(raw, `${origin}/`)
  } catch {
    throw new BrowserExtensionApiError('Invalid URL')
  }
  // Why not url.origin: Node reports "null" for chrome-extension: URLs.
  const ownPage = parseChromeExtensionUrl(url.toString())?.extensionId === caller.extension.id
  if (!ownPage && !['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) {
    throw new BrowserExtensionApiError('Invalid URL')
  }
  return url.toString()
}

function track(
  caller: BrowserExtensionCaller,
  id: number,
  item: Electron.DownloadItem,
  destination: BrowserDownloadTargetDestination | null,
  willDownload: Electron.Event
): void {
  const settled = Promise.withResolvers<void>()
  const record = createDownloadRecord(
    caller.session,
    caller.extension.id,
    id,
    item,
    destination?.savePath ?? '',
    settled.promise
  )
  // Why from the reservation: will-download must not wait on disk, and only an overwrite starts with a file there.
  emitDownloadsEvent(caller, 'onCreated', [
    describeDownloadRecord(record, { exists: destination?.replacesFile ?? false, size: null })
  ])
  let previous = { state: record.state, error: record.error }
  const report = (): void => {
    const delta = downloadRecordDelta(previous, record)
    if (delta) {
      emitDownloadsEvent(caller, 'onChanged', [delta])
      previous = { state: record.state, error: record.error }
    }
  }
  const onUpdated = (_event: Electron.Event, state: 'progressing' | 'interrupted'): void => {
    noteDownloadUpdate(record, state)
    report()
  }
  let finished = false
  let doneState: DoneState | null = null
  const finish = (error: ChromeDownloadError | null, remote = false): void => {
    if (finished) {
      return
    }
    finished = true
    item.off('updated', onUpdated)
    item.off('done', onDone)
    settleDownloadRecord(record, error, remote)
    browserDownloadDestinationReservations.release(destination?.reservationKey ?? null)
    report()
    settled.resolve()
  }
  const onDone = (_event: Electron.Event, state: DoneState): void => {
    doneState = state
    // Why: an item the manager tracks settles from its outcome, which a remote save delays.
    if (!browserManager.tracksDownload(item)) {
      finish(
        state === 'completed' ? null : state === 'interrupted' ? 'NETWORK_FAILED' : 'USER_CANCELED'
      )
    }
  }
  item.on('updated', onUpdated)
  item.once('done', onDone)
  // Why here: this listener runs before the manager's, which may finish the item inside will-download.
  // Why the route, not the outcome: a failed remote save's local path was staging too.
  browserManager.markExtensionDownload(item, (event, cause, routedRemotely = false) =>
    finish(finishedDownloadError(record, event.status, doneState, cause), routedRemotely)
  )
  // Why after the emit: a later will-download listener can refuse the item, and then done may never come.
  queueMicrotask(() => {
    if (willDownload.defaultPrevented) {
      finish('FILE_BLOCKED')
    }
  })
}

async function startDownload(
  caller: BrowserExtensionCaller,
  owner: Electron.WebContents,
  url: string,
  options: z.infer<typeof optionsSchema>,
  place: DownloadPlace,
  signal: AbortSignal
): Promise<number> {
  requireDownloadContext(signal, owner)
  const saveAs = place.savePath !== undefined
  // Why before reserving: a client-hosted page keeps only the name, as on main, and never touches local Downloads.
  const clientHosted =
    !saveAs && place.target !== undefined && browserManager.downloadRoutesToClient(owner.id)
  if (clientHosted && place.target?.overwrite) {
    throw new BrowserExtensionApiError(
      'A remote workspace cannot overwrite a file; use conflictAction "uniquify"'
    )
  }
  const destination =
    !saveAs && place.target && !clientHosted
      ? await reserveTarget(place.target, signal, owner)
      : null
  const id = nextDownloadId++
  const started = Promise.withResolvers<number>()
  const stopWaiting = (): void => {
    clearTimeout(timer)
    caller.session.off('will-download', onWillDownload)
  }
  const abandon = (): void => {
    stopWaiting()
    browserDownloadDestinationReservations.release(destination?.reservationKey ?? null)
  }
  const timer = setTimeout(() => {
    abandon()
    started.reject(new BrowserExtensionApiError('The download did not start'))
  }, WILL_DOWNLOAD_TIMEOUT_MS)
  function onWillDownload(
    event: Electron.Event,
    item: Electron.DownloadItem,
    contents: Electron.WebContents
  ): void {
    if (contents !== owner || requestedUrl(item) !== url) {
      return
    }
    stopWaiting()
    // Why: closing the window clears Downloads while a start waits, and then no one holds its path.
    if (destination && !browserDownloadDestinationReservations.holds(destination.reservationKey)) {
      // Why prevent, not cancel: Electron drops the item, and the manager's listener skips it.
      event.preventDefault()
      started.reject(
        new BrowserExtensionApiError('Downloads were reset before the download started')
      )
      return
    }
    if (place.savePath !== undefined) {
      browserManager.requestDownloadSavePath(item, place.savePath)
    } else if (destination) {
      browserManager.requestDownloadSavePath(item, destination.savePath)
    } else if (place.filename !== undefined) {
      browserManager.requestDownloadFilename(item, place.filename)
    }
    track(caller, id, item, destination, event)
    started.resolve(id)
  }
  // Why prepend: the download manager's listener reserves the destination from the filename.
  caller.session.prependListener('will-download', onWillDownload)
  const headers = Object.fromEntries(
    (options.headers ?? []).map(({ name, value }) => [name, value])
  )
  try {
    owner.downloadURL(url, { headers })
  } catch {
    // Why: the tab can be destroyed between the check above and this call.
    abandon()
    throw new BrowserExtensionApiError('The download did not start')
  }
  return started.promise
}

async function download(
  caller: BrowserExtensionCaller,
  options: z.infer<typeof optionsSchema>
): Promise<number> {
  if (options.method === 'POST') {
    throw new BrowserExtensionApiError('Orca downloads only with GET')
  }
  const saveAs = options.saveAs === true
  // Why only without saveAs: the save dialog asks before replacing a file itself.
  if (!saveAs && options.conflictAction === 'prompt') {
    throw new BrowserExtensionApiError(
      'Orca saves downloads only with conflictAction "uniquify" or "overwrite"'
    )
  }
  const requested = requestedPlace(
    options.filename,
    !saveAs && options.conflictAction === 'overwrite'
  )
  const url = resolveDownloadUrl(caller, options.url)
  const owner = downloadOwner(caller, url)
  const state = getHostSessionState(caller.session)
  if (!state) {
    throw new BrowserExtensionApiError('Extension context was unloaded')
  }
  const signal = getBrowserExtensionContextSignal(state, caller.extension.id)
  const place: DownloadPlace = { ...requested }
  if (saveAs) {
    const savePath = await chooseDownloadSavePath(owner, url, requested.filename)
    requireDownloadContext(signal)
    if (savePath === null) {
      throw new BrowserExtensionApiError('Download canceled by the user')
    }
    place.savePath = savePath
  }
  const key = `${owner.id} ${url}`
  const previous = startsInFlight.get(key) ?? Promise.resolve()
  const start = previous.then(
    () => startDownload(caller, owner, url, options, place, signal),
    () => startDownload(caller, owner, url, options, place, signal)
  )
  startsInFlight.set(key, start)
  try {
    return await start
  } finally {
    if (startsInFlight.get(key) === start) {
      startsInFlight.delete(key)
    }
  }
}

function setUiOptions(caller: BrowserExtensionCaller): void {
  if (!extensionHasPermission(caller.extension, 'downloads.ui', caller.session)) {
    throw new BrowserExtensionApiError(
      'downloads.setUiOptions requires the "downloads.ui" permission'
    )
  }
  // Why nothing to apply: Orca lists each download in its tab, and that list stays visible.
}

export function registerDownloadsNamespace(): void {
  registerBrowserExtensionNamespace('downloads', {
    permission: 'downloads',
    methods: {
      download: defineBrowserExtensionMethod(z.tuple([optionsSchema]), download),
      search: defineBrowserExtensionMethod(z.tuple([downloadQuerySchema]), searchDownloads),
      cancel: defineBrowserExtensionMethod(z.tuple([z.number().int()]), cancelDownload),
      erase: defineBrowserExtensionMethod(z.tuple([downloadQuerySchema]), eraseDownloads),
      show: defineBrowserExtensionMethod(z.tuple([z.number().int()]), showDownload),
      setUiOptions: defineBrowserExtensionMethod(
        z.tuple([z.strictObject({ enabled: z.boolean() })]),
        setUiOptions
      )
    },
    events: ['onCreated', 'onChanged', 'onErased']
  })
}
