import { app, webContents } from 'electron'
import { createServer } from 'node:http'
import { rendererPublicationThrottle } from '../../../window/visibility/renderer-publication-throttle'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'
import { OffscreenBrowserBackend } from '../offscreen-browser-backend'

const SAVED_WORKTREE = 'saved-worktree'

async function waitUntil(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function run(): Promise<void> {
  // Serve must survive with no page open; keep Electron alive after last-window close.
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<h1>${request.url}</h1>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fixture server has no port')
  }
  const origin = `http://127.0.0.1:${address.port}`
  const browserManager = {
    registerOffscreenGuest: () => true,
    unregisterGuest: () => {},
    isAgentUsingPage: () => false,
    getPopupPages: () => []
  }
  const backend = new OffscreenBrowserBackend(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: page lifetime only calls these members.
    browserManager as unknown as BrowserManager,
    { isPageSaved: (page) => page.worktreeId === SAVED_WORKTREE, idleFreeMs: () => 300 }
  )
  const pageOf = (id: string): Electron.WebContents => {
    const guest = webContents.fromId(backend.getWebContentsId(id) ?? -1)
    if (!guest) {
      throw new Error(`Page ${id} has no WebContents`)
    }
    return guest
  }

  // A page whose tab is not saved could not come back, so it is never freed.
  const unsaved = await backend.createTab({ url: `${origin}/first`, worktreeId: 'unsaved' })
  const saved = await backend.createTab({ url: `${origin}/first`, worktreeId: SAVED_WORKTREE })
  const savedGuest = pageOf(saved.browserPageId)
  // Navigating under a command's lease; the idle time only starts once the lease ends.
  const releaseNavigation = rendererPublicationThrottle.acquire(savedGuest)
  await waitUntil(
    () =>
      savedGuest.getURL() !== '' &&
      new URL(savedGuest.getURL()).pathname === '/first' &&
      !savedGuest.isLoading()
  )
  await savedGuest.loadURL(`${origin}/second`)
  releaseNavigation()

  await waitUntil(() => !backend.ownsTab(saved.browserPageId))
  const unsavedKept = backend.ownsTab(unsaved.browserPageId)
  const savedFreed = savedGuest.isDestroyed()

  // The next use starts the saved tab again under its id, as ServeBrowserTabs.restore does.
  await backend.createTab({
    browserPageId: saved.browserPageId,
    url: `${origin}/second`,
    worktreeId: SAVED_WORKTREE
  })
  const woken = pageOf(saved.browserPageId)
  // A command holds this lease while it runs, which also keeps the woken page from being freed.
  const releaseWoken = rendererPublicationThrottle.acquire(woken)
  await waitUntil(() => !woken.isLoading() && woken.getURL() !== '')
  const wokenUrl = new URL(woken.getURL()).pathname
  const wokenHistoryLength = woken.navigationHistory.length()
  woken.navigationHistory.goBack()
  await waitUntil(() => new URL(woken.getURL()).pathname === '/first' && !woken.isLoading())
  const backUrl = new URL(woken.getURL()).pathname
  releaseWoken()

  await backend.destroyAll()
  server.close()
  console.log(JSON.stringify({ unsavedKept, savedFreed, wokenUrl, wokenHistoryLength, backUrl }))
  app.exit(0)
}

const deadline = setTimeout(() => app.exit(2), 30_000)
void run().catch((error: unknown) => {
  clearTimeout(deadline)
  console.error(error)
  app.exit(1)
})
