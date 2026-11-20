import { app, BrowserWindow, webContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyBackgroundActivationPolicy } from '../../../window/activation/foreground-activation-policy'
import { BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL } from '../../../../shared/browser/guest-lifecycle/browser-guest-page-visibility'
import { installBrowserGuestPageVisibilityReport } from '../../../../preload/browser/visibility/browser-guest-page-visibility-report'
import { listenForBrowserGuestPageVisibility } from './browser-guest-page-visibility'

type FrameRead = { visibilityState: string; hidden: boolean; events: string[] }

const recordEvents =
  "window.__events=[];document.addEventListener('visibilitychange',()=>__events.push(document.visibilityState))"
const plainPage = encodeURIComponent(`<script>${recordEvents}</script>`)
const framedPage = encodeURIComponent(
  `<script>${recordEvents}</script><iframe srcdoc="<script>${recordEvents}</script>"></iframe>`
)
const host = `<!doctype html><body>
<webview id="first" src="data:text/html,${framedPage}" style="width:300px;height:200px"></webview>
<div id="second-tab" style="display:none"><webview id="second" src="data:text/html,${plainPage}" style="width:300px;height:200px"></webview></div>
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
;(${installBrowserGuestPageVisibilityReport.toString()})((state) => ipcRenderer.send(${JSON.stringify(BROWSER_GUEST_PAGE_VISIBILITY_CHANNEL)}, state))`
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
    preferences.nodeIntegrationInSubFrames = true
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
  const frames = (target: Electron.WebContents): Electron.WebFrameMain[] => [
    target.mainFrame,
    ...target.mainFrame.frames
  ]
  const read = (target: Electron.WebContents): Promise<FrameRead[]> =>
    Promise.all(
      frames(target).map((frame) =>
        frame.executeJavaScript(
          '({ visibilityState: document.visibilityState, hidden: document.hidden, events: window.__events ?? [] })'
        )
      )
    )
  // Every frame of the page, settled on one state: [visibilityState, hidden, last event].
  const settle = async (target: Electron.WebContents, state: string): Promise<unknown> => {
    await until(
      async () =>
        !target.isLoading() &&
        frames(target).length === (target === first ? 2 : 1) &&
        (await read(target)).every((frame) => frame.visibilityState === state)
    ).catch(() => undefined)
    return (await read(target)).map((frame) => [
      frame.visibilityState,
      frame.hidden,
      frame.events.at(-1) ?? null
    ])
  }
  const eventCounts = async (target: Electron.WebContents): Promise<number[]> =>
    (await read(target)).map((frame) => frame.events.length)

  const loaded = { first: await settle(first, 'visible'), second: await settle(second, 'hidden') }

  // What BrowserWindow emits when the window is restored: Electron sends it to every guest.
  const before = await eventCounts(second)
  window.webContents.emit('-window-visibility-change', 'visible')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const backgroundEventsOnRestore = (await eventCounts(second)).map(
    (count, index) => count - before[index]
  )

  // Minimizing the window hides the shown tab even when Chromium keeps it painted.
  window.webContents.emit('-window-visibility-change', 'hidden')
  const windowHidden = await until(
    async () => (await read(first))[0].visibilityState === 'hidden'
  ).then(
    async () => (await read(first))[0].visibilityState,
    () => 'visible'
  )
  window.webContents.emit('-window-visibility-change', 'visible')
  const windowRestored = await until(
    async () => (await read(first))[0].visibilityState === 'visible'
  ).then(
    async () => (await read(first))[0].visibilityState,
    () => 'hidden'
  )

  await window.webContents.executeJavaScript(
    `document.getElementById('first').style.display = 'none'; document.getElementById('second-tab').style.display = 'block'`
  )
  const switched = { first: await settle(first, 'hidden'), second: await settle(second, 'visible') }

  first.reload()
  const reloadedInBackground = await settle(first, 'hidden')

  console.log(
    JSON.stringify({
      loaded,
      backgroundEventsOnRestore,
      windowHidden,
      windowRestored,
      switched,
      reloadedInBackground
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
