import { webContents as allWebContents } from 'electron'
import { z } from 'zod'
import {
  getChromeExtensionOrigin,
  parseChromeExtensionUrl
} from '../../../../shared/browser-extension-url'
import { browserManager } from '../../browser-manager'
import { emitBrowserExtensionEvent } from '../browser-extension-api-host'
import { getBrowserExtensionContextSignal } from '../browser-extension-context-lifetime'
import { getHostSessionState } from '../browser-extension-contexts'
import { chooseDownloadSavePath } from './downloads-save-as'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { getActiveBrowserTabId } from '../browser-extension-tab-model'

const WILL_DOWNLOAD_TIMEOUT_MS = 15_000
let nextDownloadId = 1
/** Owner + URL → the start in flight; will-download names no caller, so identical starts take turns. */
const startsInFlight = new Map<string, Promise<unknown>>()

/** A name inside Downloads, or with saveAs, the exact path the user chose. */
type DownloadPlace = { filename?: string; savePath?: string }

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

type ChromeDownloadState = 'in_progress' | 'interrupted' | 'complete'

function chromeState(item: Electron.DownloadItem): ChromeDownloadState {
  const state = item.getState()
  return state === 'completed'
    ? 'complete'
    : state === 'progressing'
      ? 'in_progress'
      : 'interrupted'
}

// Why the chain: getURL is the URL after redirects; Chrome's `url` is the one requested.
function requestedUrl(item: Electron.DownloadItem): string {
  return item.getURLChain()[0] ?? item.getURL()
}

function describeItem(id: number, item: Electron.DownloadItem, extensionId: string) {
  return {
    id,
    url: requestedUrl(item),
    finalUrl: item.getURL(),
    referrer: '',
    filename: item.getSavePath(),
    incognito: false,
    danger: 'safe',
    mime: item.getMimeType(),
    startTime: new Date(item.getStartTime() * 1000).toISOString(),
    state: chromeState(item),
    paused: item.isPaused(),
    canResume: item.canResume(),
    bytesReceived: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes(),
    fileSize: item.getTotalBytes(),
    exists: true,
    byExtensionId: extensionId
  }
}

/** Why a tab: Orca's download UI belongs to a page, so a worker's download lands on the active tab. */
function downloadOwner(caller: BrowserExtensionCaller): Electron.WebContents {
  const own = caller.webContents
  if (own && !own.isDestroyed() && browserManager.getTabIdForWebContentsId(own.id)) {
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

function emit(caller: BrowserExtensionCaller, event: string, args: unknown[]): void {
  emitBrowserExtensionEvent(
    { session: caller.session, extensionId: caller.extension.id },
    'downloads',
    event,
    args
  )
}

function track(caller: BrowserExtensionCaller, id: number, item: Electron.DownloadItem): void {
  emit(caller, 'onCreated', [describeItem(id, item, caller.extension.id)])
  let previous = chromeState(item)
  const report = (): void => {
    const current = chromeState(item)
    if (current !== previous) {
      emit(caller, 'onChanged', [{ id, state: { previous, current } }])
      previous = current
    }
  }
  item.on('updated', report)
  item.once('done', () => {
    item.off('updated', report)
    report()
  })
}

/** Chrome's rule: relative to Downloads, no back-references. Orca keeps only the last segment. */
function requestedFilename(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  const segments = raw.split(/[\\/]/)
  if (
    raw.trim() === '' ||
    /^([\\/]|[A-Za-z]:)/.test(raw) ||
    segments.some((segment) => segment === '..')
  ) {
    throw new BrowserExtensionApiError('Invalid filename')
  }
  return raw
}

function startDownload(
  caller: BrowserExtensionCaller,
  owner: Electron.WebContents,
  url: string,
  options: z.infer<typeof optionsSchema>,
  place: DownloadPlace,
  signal: AbortSignal
): Promise<number> {
  requireDownloadContext(signal)
  // Why: the tab can close during the save dialog or an earlier identical start.
  if (owner.isDestroyed()) {
    throw new BrowserExtensionApiError('The tab closed before the download started')
  }
  const id = nextDownloadId++
  const started = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      caller.session.off('will-download', onWillDownload)
      reject(new BrowserExtensionApiError('The download did not start'))
    }, WILL_DOWNLOAD_TIMEOUT_MS)
    function onWillDownload(
      _event: Electron.Event,
      item: Electron.DownloadItem,
      contents: Electron.WebContents
    ): void {
      if (contents !== owner || requestedUrl(item) !== url) {
        return
      }
      clearTimeout(timer)
      caller.session.off('will-download', onWillDownload)
      browserManager.markExtensionDownload(item)
      if (place.savePath !== undefined) {
        browserManager.requestDownloadSavePath(item, place.savePath)
      } else if (place.filename !== undefined) {
        browserManager.requestDownloadFilename(item, place.filename)
      }
      track(caller, id, item)
      resolve(id)
    }
    // Why prepend: the download manager's listener reserves the destination from the filename.
    caller.session.prependListener('will-download', onWillDownload)
  })
  const headers = Object.fromEntries(
    (options.headers ?? []).map(({ name, value }) => [name, value])
  )
  owner.downloadURL(url, { headers })
  return started
}

function requireDownloadContext(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BrowserExtensionApiError('Extension context was unloaded')
  }
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
  if (!saveAs && options.conflictAction !== undefined && options.conflictAction !== 'uniquify') {
    throw new BrowserExtensionApiError('Orca saves downloads only with conflictAction "uniquify"')
  }
  const filename = requestedFilename(options.filename)
  const url = resolveDownloadUrl(caller, options.url)
  const owner = downloadOwner(caller)
  const state = getHostSessionState(caller.session)
  if (!state) {
    throw new BrowserExtensionApiError('Extension context was unloaded')
  }
  const signal = getBrowserExtensionContextSignal(state, caller.extension.id)
  const place: DownloadPlace = { filename }
  if (saveAs) {
    const savePath = await chooseDownloadSavePath(owner, url, filename)
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

export function registerDownloadsNamespace(): void {
  registerBrowserExtensionNamespace('downloads', {
    permission: 'downloads',
    methods: {
      download: defineBrowserExtensionMethod(z.tuple([optionsSchema]), download)
    },
    events: ['onCreated', 'onChanged']
  })
}
