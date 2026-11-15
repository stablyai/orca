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
  // Electron destroys a window's WebContents after destroy() returns, so wait for its event.
  const savedDestroyed = new Promise<void>((resolve) =>
    savedGuest.once('destroyed', () => resolve())
  )
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

  await savedDestroyed
  const unsavedKept = backend.ownsTab(unsaved.browserPageId)
  const savedFreed = !backend.ownsTab(saved.browserPageId)

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

  const privateUrl = 'https://kagi.com/search?q=cold&token=synthetic-offscreen-secret'
  const requests: string[] = []
  pageOf(unsaved.browserPageId).session.protocol.handle('https', (request) => {
    requests.push(request.url)
    return new Response(
      `<title>${privateUrl}</title><script>history.replaceState({}, '', '/search?q=cold')</script>`,
      { headers: { 'content-type': 'text/html' } }
    )
  })
  let privateRestore: { entries: { url: string; title: string; hasPageState: boolean }[] } | null =
    null
  app.on('web-contents-created', (_event, contents) => {
    const restore = contents.navigationHistory.restore.bind(contents.navigationHistory)
    contents.navigationHistory.restore = (options) => {
      privateRestore = {
        entries: options.entries.map((entry) => ({
          url: entry.url,
          title: entry.title,
          hasPageState: entry.pageState !== undefined
        }))
      }
      return restore(options)
    }
  })
  const privatePage = await backend.createTab({ url: privateUrl, worktreeId: SAVED_WORKTREE })
  const privateGuest = pageOf(privatePage.browserPageId)
  const releasePrivate = rendererPublicationThrottle.acquire(privateGuest)
  const privateDestroyed = new Promise<void>((resolve) => privateGuest.once('destroyed', resolve))
  await waitUntil(
    () => privateGuest.getURL() === 'https://kagi.com/search?q=cold' && !privateGuest.isLoading()
  )
  releasePrivate()
  await privateDestroyed
  await backend.createTab({
    browserPageId: privatePage.browserPageId,
    url: 'https://kagi.com/search?q=cold',
    worktreeId: SAVED_WORKTREE
  })
  const privateRequestReceived = requests.includes(privateUrl)
  await waitUntil(() => privateRestore !== null)

  await backend.destroyAll()
  server.close()
  console.log(
    JSON.stringify({
      unsavedKept,
      savedFreed,
      wokenUrl,
      wokenHistoryLength,
      backUrl,
      privateRequestReceived,
      privateRestore
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
