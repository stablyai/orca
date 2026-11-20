import { app, BrowserWindow, webContents } from 'electron'
import { applyBackgroundActivationPolicy } from '../../../window/activation/foreground-activation-policy'
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
  // The shipped browser guest preload, bundled by the test.
  const preload = process.env.ORCA_BROWSER_GUEST_PRELOAD
  if (!preload) {
    throw new Error('Missing browser guest preload')
  }
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
  const frames = (target: Electron.WebContents): Electron.WebFrameMain[] =>
    target.mainFrame.framesInSubtree
  const read = (target: Electron.WebContents): Promise<FrameRead[]> =>
    Promise.all(
      frames(target).map((frame) =>
        frame
          .executeJavaScript(
            'JSON.stringify({ visibilityState: document.visibilityState, hidden: document.hidden, events: window.__events ?? [] })'
          )
          .then((json) => JSON.parse(String(json)))
      )
    )
  // Every frame of the page, settled on one state: [visibilityState, hidden, last event].
  const settle = async (
    target: Electron.WebContents,
    state: string,
    frameCount: number
  ): Promise<unknown> => {
    await until(
      async () =>
        !target.isLoading() &&
        frames(target).length === frameCount &&
        (await read(target)).every((frame) => frame.visibilityState === state)
    ).catch(() => undefined)
    return (await read(target)).map((frame) => [
      frame.visibilityState,
      frame.hidden,
      frame.events.at(-1) ?? null
    ])
  }
  const firstPageState = async (state: string): Promise<string> => {
    await until(async () => (await read(first))[0].visibilityState === state).catch(() => undefined)
    return (await read(first))[0].visibilityState
  }
  const eventCounts = async (target: Electron.WebContents): Promise<number[]> =>
    (await read(target)).map((frame) => frame.events.length)

  const loaded = {
    first: await settle(first, 'visible', 2),
    second: await settle(second, 'hidden', 1)
  }

  // What BrowserWindow emits when the window is restored: Electron sends it to every guest.
  const before = await eventCounts(second)
  window.webContents.emit('-window-visibility-change', 'visible')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const backgroundEventsOnRestore = (await eventCounts(second)).map(
    (count, index) => count - before[index]
  )

  // Minimizing the window hides the shown tab even when Chromium keeps it painted.
  window.webContents.emit('-window-visibility-change', 'hidden')
  const windowHidden = await firstPageState('hidden')
  window.webContents.emit('-window-visibility-change', 'visible')
  const windowRestored = await firstPageState('visible')

  await window.webContents.executeJavaScript(
    `document.getElementById('first').style.display = 'none'; document.getElementById('second-tab').style.display = 'block'`
  )
  const switched = {
    first: await settle(first, 'hidden', 2),
    second: await settle(second, 'visible', 1)
  }

  first.reload()
  const reloadedInBackground = await settle(first, 'hidden', 2)

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
