import { app, BrowserWindow, webContents } from 'electron'
import { createServer } from 'node:http'
import { rendererPublicationThrottle } from '../../../window/visibility/renderer-publication-throttle'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'
import { OffscreenBrowserBackend } from '../offscreen-browser-backend'

// Animation frames the page draws in two seconds.
const FRAMES_IN_TWO_SECONDS = `new Promise((resolve) => {
  let frames = 0
  const tick = () => { frames += 1; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  setTimeout(() => resolve(frames), 2000)
})`

async function run(): Promise<void> {
  // Serve must survive with no page open; keep Electron alive after last-window close.
  app.on('window-all-closed', () => {})
  await app.whenReady()
  // Under Xvfb a fresh process's first offscreen window can come up without frames; spend it here.
  const warmUp = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await warmUp.loadURL('about:blank')
  warmUp.destroy()
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<h1>Offscreen page</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fixture server has no port')
  }
  const browserManager = {
    registerOffscreenGuest: () => true,
    unregisterGuest: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createTab and closeTab only call these two members.
  const backend = new OffscreenBrowserBackend(browserManager as unknown as BrowserManager)
  const { browserPageId } = await backend.createTab({ url: 'about:blank' })
  const guest = webContents.fromId(backend.getWebContentsId(browserPageId) ?? -1)
  if (!guest) {
    throw new Error('Offscreen page has no WebContents')
  }
  await guest.loadURL(`http://127.0.0.1:${address.port}/`)
  const unwatched = Number(await guest.executeJavaScript(FRAMES_IN_TWO_SECONDS))
  const processBefore = guest.getOSProcessId()
  // A different site swaps in a new renderer process and view, which must keep the slow rate.
  await guest.loadURL(`http://localhost:${address.port}/`)
  const swappedProcess = guest.getOSProcessId() !== processBefore
  const unwatchedAfterSiteSwap = Number(await guest.executeJavaScript(FRAMES_IN_TWO_SECONDS))

  // Agent commands, captures and screencasts hold this lease while they need frames.
  const release = rendererPublicationThrottle.acquire(guest)
  const watched = Number(await guest.executeJavaScript(FRAMES_IN_TWO_SECONDS))
  release()
  // Slow CI draws fewer frames at any rate, so the leased page only has to clearly outpace the rest.
  const watchedOutpacesUnwatched = watched >= 3 * Math.max(unwatched, unwatchedAfterSiteSwap, 4)
  const visibility: unknown = await guest.executeJavaScript('document.visibilityState')

  await backend.closeTab(browserPageId)
  server.close()
  console.log(
    JSON.stringify({
      unwatched,
      swappedProcess,
      unwatchedAfterSiteSwap,
      watched,
      watchedOutpacesUnwatched,
      visibility
    })
  )
  app.exit(0)
}

const deadline = setTimeout(() => app.exit(2), 30_000)
void run().catch((error: unknown) => {
  clearTimeout(deadline)
  console.error(error)
  app.exit(1)
})
