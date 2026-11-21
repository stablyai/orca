import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { applyBackgroundActivationPolicy } from '../../../../window/activation/foreground-activation-policy'
import { readBrowserPageStateFormData } from './browser-page-state-form-data'

const form = (action: string): string =>
  `<form id="f" method="post" action="${action}"><input name="q" value="1"></form>`

const server = createServer((request, response) => {
  const path = request.url ?? '/'
  if (request.method === 'POST' && path === '/see-other') {
    response.writeHead(303, { location: '/landed' }).end()
  } else if (request.method === 'POST' && path === '/temporary') {
    response.writeHead(307, { location: '/result' }).end()
  } else {
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(`<title>${path}</title>${path.startsWith('/form') ? form(path.slice(5)) : path}`)
  }
})

// The next committed document, once it has finished loading (not a late event of the last one).
async function load(win: BrowserWindow, run: () => Promise<unknown>): Promise<string> {
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-navigate', () => win.webContents.once('did-stop-loading', resolve))
  )
  await run()
  await loaded
  // The raw header, so a format change is easy to read in the failure output.
  const history = win.webContents.navigationHistory
  const state = history.getEntryAtIndex(history.getActiveIndex())?.pageState ?? ''
  process.stderr.write(
    `${win.webContents.getURL()} ${Buffer.from(state, 'base64').subarray(0, 16).toString('hex')}\n`
  )
  return readBrowserPageStateFormData(state)
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
    temporary: await submit('/temporary')
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
  server.close()
  app.exit(0)
}

void run().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  app.exit(1)
})
