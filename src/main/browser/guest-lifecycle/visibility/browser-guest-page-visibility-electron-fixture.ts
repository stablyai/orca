import { app, BrowserWindow, webContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyBackgroundActivationPolicy } from '../../../window/activation/foreground-activation-policy'
import { BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL } from '../../../../shared/browser/guest-lifecycle/browser-guest-page-visibility'
import { installBrowserGuestPageVisibilityReport } from '../../../../preload/browser/visibility/browser-guest-page-visibility-report'
import { listenForBrowserGuestPageVisibility } from './browser-guest-page-visibility'

type PageRead = {
  visibilityState: string
  hidden: boolean
  lastEvent: string | null
  events: number
}

const page = encodeURIComponent(
  '<script>window.__events=[];document.addEventListener("visibilitychange",()=>__events.push(document.visibilityState))</script>'
)
const host = `<!doctype html><body>
<webview id="first" src="data:text/html,${page}" style="width:300px;height:200px"></webview>
<div id="second-tab" style="display:none"><webview id="second" src="data:text/html,${page}" style="width:300px;height:200px"></webview></div>
</body>`

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for guest visibility')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function run(): Promise<void> {
  applyBackgroundActivationPolicy()
  await app.whenReady()
  const preload = join(app.getPath('userData'), 'visibility-preload.cjs')
  writeFileSync(
    preload,
    `const { ipcRenderer } = require('electron')
if (process.isMainFrame) (${installBrowserGuestPageVisibilityReport.toString()})((state) => ipcRenderer.send(${JSON.stringify(BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL)}, state))`
  )
  listenForBrowserGuestPageVisibility()
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true }
  })
  window.webContents.on('will-attach-webview', (_event, preferences) => {
    preferences.preload = preload
    preferences.sandbox = true
    preferences.contextIsolation = true
  })
  await window.loadURL(`data:text/html,${encodeURIComponent(host)}`)
  const guest = async (id: string): Promise<Electron.WebContents> => {
    let guestId = 0
    await until(async () => {
      guestId = await window.webContents.executeJavaScript(
        `(() => { try { return document.getElementById(${JSON.stringify(id)}).getWebContentsId() } catch { return 0 } })()`
      )
      return guestId > 0
    })
    const found = webContents.fromId(guestId)
    if (!found) {
      throw new Error(`Missing guest ${id}`)
    }
    return found
  }
  const first = await guest('first')
  const second = await guest('second')
  const read = (target: Electron.WebContents): Promise<PageRead> =>
    target.executeJavaScript(
      '({ visibilityState: document.visibilityState, hidden: document.hidden, lastEvent: window.__events?.at(-1) ?? null, events: window.__events?.length ?? 0 })'
    )
  const settle = (target: Electron.WebContents, state: string): Promise<void> =>
    until(
      async () =>
        !target.isLoading() &&
        (await target.executeJavaScript('document.readyState')) === 'complete' &&
        (await read(target)).visibilityState === state
    ).catch(() => undefined)

  await settle(first, 'visible')
  await settle(second, 'hidden')
  const loaded = { first: await read(first), second: await read(second) }

  // What BrowserWindow emits when the window is restored: Electron sends it to every guest.
  window.webContents.emit('-window-visibility-change', 'visible')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const windowShown = {
    first: (await read(first)).events - loaded.first.events,
    second: (await read(second)).events - loaded.second.events
  }

  await window.webContents.executeJavaScript(
    `document.getElementById('first').style.display = 'none'; document.getElementById('second-tab').style.display = 'block'`
  )
  await settle(first, 'hidden')
  await settle(second, 'visible')
  const switched = { first: await read(first), second: await read(second) }

  first.reload()
  await settle(first, 'hidden')
  const { visibilityState, hidden } = await read(first)

  const state = ({ visibilityState, hidden, lastEvent }: PageRead) => ({
    visibilityState,
    hidden,
    lastEvent
  })
  console.log(
    JSON.stringify({
      loaded: {
        first: { visibilityState: loaded.first.visibilityState, hidden: loaded.first.hidden },
        second: { visibilityState: loaded.second.visibilityState, hidden: loaded.second.hidden }
      },
      windowShown,
      switched: { first: state(switched.first), second: state(switched.second) },
      reloadedInBackground: { visibilityState, hidden }
    })
  )
}

run().then(
  () => app.exit(0),
  (error) => {
    console.error(error)
    app.exit(1)
  }
)
