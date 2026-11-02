import { app, BrowserWindow } from 'electron'
import { startBrowserScreencast } from '../browser/browser-screencast-stream'
import { RendererPublicationThrottle } from './renderer-publication-throttle'

async function run(): Promise<void> {
  // Why: serve keeps running with no page open; Electron would otherwise quit at the first close.
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const throttle = new RendererPublicationThrottle()
  let frames = 0
  let releasesDuringDestruction = 0
  let restoreCalls = 0
  let captureCalls = 0

  for (let iteration = 0; iteration < 3; iteration += 1) {
    // Why: headless serve backs each page with a hidden top-level window; a <webview> guest's
    // child-frame view never reached the crashing Aura path.
    const page = new BrowserWindow({
      show: false,
      width: 640,
      height: 480,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const guest = page.webContents
    const release = throttle.acquire({
      isDestroyed: () => guest.isDestroyed(),
      isFocused: () => guest.isFocused(),
      setBackgroundThrottling: (allowed) => {
        if (allowed) {
          restoreCalls += 1
        }
        guest.setBackgroundThrottling(allowed)
      },
      capturePage: (rect, options) => {
        captureCalls += 1
        return guest.capturePage(rect, options)
      }
    })
    await page.loadURL('data:text/html,<h1>Streamed page</h1>')
    let firstFrame!: () => void
    const ready = new Promise<void>((resolve) => {
      firstFrame = resolve
    })
    const session = await startBrowserScreencast(guest, {
      format: 'jpeg',
      quality: 60,
      maxWidth: 640,
      maxHeight: 480,
      everyNthFrame: 1,
      minFrameIntervalMs: 0,
      onFrame: () => {
        frames += 1
        firstFrame()
      }
    })
    // Match the runtime's promise chain: detach settles done inside native destruction.
    const released = Promise.resolve(session)
      .then((stream) => stream.done)
      .finally(() => {
        if (!guest.isDestroyed()) {
          releasesDuringDestruction += 1
        }
        release()
      })
    await ready
    page.destroy()
    await released
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (!guest.isDestroyed()) {
      throw new Error('Streamed guest was not destroyed')
    }
  }

  // A surviving host must still be able to serve another browser operation.
  const host = new BrowserWindow({ show: false, width: 640, height: 480 })
  await host.loadURL('data:text/html,<h1>Host is still reachable</h1>')
  const title = await host.webContents.executeJavaScript('document.querySelector("h1").textContent')
  console.log(
    JSON.stringify({ frames, releasesDuringDestruction, restoreCalls, captureCalls, title })
  )
  host.destroy()
  app.exit(0)
}

const deadline = setTimeout(() => app.exit(2), 30_000)
void run().catch((error: unknown) => {
  clearTimeout(deadline)
  console.error(error)
  app.exit(1)
})
