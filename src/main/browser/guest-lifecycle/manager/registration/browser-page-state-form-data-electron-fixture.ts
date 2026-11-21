import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { applyBackgroundActivationPolicy } from '../../../../window/activation/foreground-activation-policy'
import {
  readBrowserGuestCurrentFormData,
  readBrowserPageStateFormData
} from './browser-page-state-form-data'

const form = (action: string): string =>
  `<form id="f" method="post" action="${action}"><input name="q" value="1"></form>`

// A select whose saved value is a content type, as Chromium keeps form control state on the entry.
const SELECT_PAGE =
  '<select name="t"><option value="a">a</option><option value="text/plain">p</option></select>'

const server = createServer((request, response) => {
  const path = request.url ?? '/'
  if (request.method === 'POST' && path === '/see-other') {
    response.writeHead(303, { location: '/landed' }).end()
  } else if (request.method === 'POST' && path === '/temporary') {
    response.writeHead(307, { location: '/result' }).end()
  } else {
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<title>${path}</title>${
          path.startsWith('/form') ? form(path.slice(5)) : path === '/select' ? SELECT_PAGE : path
        }`
      )
  }
})

// The next committed document, once it has finished loading (not a late event of the last one).
async function load(win: BrowserWindow, run: () => Promise<unknown>): Promise<string> {
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-navigate', () => win.webContents.once('did-stop-loading', resolve))
  )
  await run()
  await loaded
  // The raw header and the bytes before each content type, so a format change is easy to read.
  const history = win.webContents.navigationHistory
  const state = history.getEntryAtIndex(history.getActiveIndex())?.pageState ?? ''
  describe(win.webContents.getURL(), state)
  return readBrowserPageStateFormData(state)
}

const TEXT_PLAIN = Buffer.from('text/plain', 'utf16le')

function describe(label: string, state: string): void {
  const bytes = Buffer.from(state, 'base64')
  const lines = [`${label} ${bytes.subarray(0, 16).toString('hex')}`]
  for (const type of [TEXT_PLAIN, Buffer.from('application/x-www-form-urlencoded', 'utf16le')]) {
    for (let at = bytes.indexOf(type); at !== -1; at = bytes.indexOf(type, at + 2)) {
      lines.push(`  @${at} ${bytes.subarray(Math.max(0, at - 64), at).toString('hex')}`)
    }
  }
  process.stderr.write(`${lines.join('\n')}\n`)
}

// Reads the entry as the first History API update starts, then once it has landed.
async function replaceState(win: BrowserWindow): Promise<{ before: string; after: string }> {
  const contents = win.webContents
  const before = new Promise<string>((resolve) =>
    contents.once('did-start-navigation', () => resolve(readBrowserGuestCurrentFormData(contents)))
  )
  const landed = new Promise<void>((resolve) =>
    contents.once('did-navigate-in-page', () => resolve())
  )
  await contents.executeJavaScript('history.replaceState(null, "", location.href)')
  await landed
  return { before: await before, after: readBrowserGuestCurrentFormData(contents) }
}

// A GET page whose saved select value is a content type, read once the page is left behind.
async function savedSelect(win: BrowserWindow, origin: string): Promise<unknown> {
  await win.loadURL(`${origin}/select`)
  await win.webContents.executeJavaScript(
    'document.querySelector("select").value = "text/plain"; document.querySelector("select").dispatchEvent(new Event("change"))'
  )
  await load(win, () => win.loadURL(`${origin}/plain`))
  const history = win.webContents.navigationHistory
  const state = history.getEntryAtIndex(history.getActiveIndex() - 1)?.pageState ?? ''
  describe('select', state)
  return {
    savesType: Buffer.from(state, 'base64').includes(TEXT_PLAIN),
    formData: readBrowserPageStateFormData(state)
  }
}

async function run(): Promise<void> {
  applyBackgroundActivationPolicy()
  await app.whenReady()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  const win = new BrowserWindow({ show: false })
  const submit = async (action: string): Promise<string> => {
    await win.loadURL(`${origin}/form${action}`)
    return load(win, () =>
      win.webContents.executeJavaScript('document.getElementById("f").submit()')
    )
  }
  const output = {
    plain: await load(win, () => win.loadURL(`${origin}/plain`)),
    post: await submit('/result'),
    seeOther: await submit('/see-other'),
    temporary: await submit('/temporary'),
    replaced: await submit('/replaced').then(() => replaceState(win)),
    savedSelect: await savedSelect(win, origin)
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
  server.close()
  app.exit(0)
}

void run().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  app.exit(1)
})
