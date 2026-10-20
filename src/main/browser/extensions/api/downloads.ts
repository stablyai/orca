import { webContents as allWebContents } from 'electron'
import { z } from 'zod'
import { getChromeExtensionOrigin } from '../../../../shared/browser-extension-url'
import { browserManager } from '../../browser-manager'
import { emitBrowserExtensionEvent } from '../browser-extension-api-host'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import { getActiveBrowserTabId } from '../browser-extension-tab-model'

const WILL_DOWNLOAD_TIMEOUT_MS = 15_000
let nextDownloadId = 1

const optionsSchema = z
  .object({
    url: z.string().min(1),
    filename: z.string(),
    saveAs: z.boolean(),
    method: z.enum(['GET', 'POST']),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
    body: z.string(),
    conflictAction: z.string()
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

function describeItem(id: number, item: Electron.DownloadItem, extensionId: string) {
  return {
    id,
    url: item.getURL(),
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
  const ownPage = url.protocol === 'chrome-extension:' && url.origin === origin
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

async function download(
  caller: BrowserExtensionCaller,
  options: z.infer<typeof optionsSchema>
): Promise<number> {
  if (options.method === 'POST') {
    throw new BrowserExtensionApiError('Orca downloads only with GET')
  }
  const url = resolveDownloadUrl(caller, options.url)
  const owner = downloadOwner(caller)
  const id = nextDownloadId++
  const started = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      caller.session.off('will-download', onWillDownload)
      reject(new BrowserExtensionApiError('The download did not start'))
    }, WILL_DOWNLOAD_TIMEOUT_MS)
    function onWillDownload(
      _event: Electron.Event,
      item: Electron.DownloadItem,
      contents: Electron.WebContents
    ): void {
      if (contents !== owner || item.getURL() !== url) {
        return
      }
      clearTimeout(timer)
      caller.session.off('will-download', onWillDownload)
      track(caller, id, item)
      resolve()
    }
    caller.session.on('will-download', onWillDownload)
  })
  const headers = Object.fromEntries(
    (options.headers ?? []).map(({ name, value }) => [name, value])
  )
  owner.downloadURL(url, { headers })
  await started
  return id
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
