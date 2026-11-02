import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runBrowserRouteEgressElectron } from '../../browser/browser-route-egress-electron-launch'
import {
  isPluginFrameCancelledRequestEcho,
  pluginFrameCspBlock
} from './plugin-frame-blocked-requests'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// A hidden window under `default-src 'none'` that tries each kind of request, then records the
// console lines this Electron prints for them. Why script-driven: markup-only fonts and media load
// only when the page lays out, which a hidden Linux window may never do, so a wait for their
// refusals hung there.
const PROBE = `
const tries = [
  () => new FontFace('x', 'url(https://fonts.example.com/a.woff2)').load(),
  () => element('link', { rel: 'stylesheet', href: 'https://cdn.example.com/a.css' }),
  () => element('img', { src: 'https://img.example.com/a.png' }),
  () => element('iframe', { src: 'https://frame.example.com/' }),
  () => element('video', { src: 'https://media.example.com/a.mp4', preload: 'auto' }),
  () => element('script', { src: 'https://js.example.com/a.js' }),
  () => fetch('https://api.example.com/x')
]
// Settles on the request's own outcome, so a kind that is never refused cannot hang the probe.
function element(tag, attributes) {
  return new Promise((settle) => {
    const node = Object.assign(document.createElement(tag), attributes)
    node.onload = node.onerror = settle
    document.body.append(node)
    if (tag === 'video') node.load()
  })
}
Promise.allSettled(tries.map((attempt) => attempt())).then(() => console.log('csp-probe-done'))
`
const PAGE = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
</head><body><script>${PROBE}</script></body></html>`

const MAIN = String.raw`
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
// Why the config: Linux launches append --no-sandbox, so a position counted from the end moves.
const { resultPath } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, focusable: false })
  const messages = []
  // Each refusal is logged before its request settles, so the page's done line comes after all.
  win.webContents.on('console-message', (event) => {
    if (event.message !== 'csp-probe-done') {
      messages.push(event.message)
      return
    }
    writeFileSync(resultPath, JSON.stringify({ messages }))
    app.exit(0)
  })
  void win.loadURL('data:text/html;base64,' + Buffer.from(${JSON.stringify(PAGE)}).toString('base64'))
})
`

describe('content-policy refusals from the bundled Electron', () => {
  // Why longer: launching Electron alone can pass the default; the launcher kills it at 30s.
  it('reads every refusal it prints as a blocked origin', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-frame-csp-'))
    roots.push(root)
    const mainPath = join(root, 'main.cjs')
    writeFileSync(mainPath, MAIN)
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ resultPath: join(root, 'result.json') })
    )

    const { messages } = await runBrowserRouteEgressElectron(root, mainPath)

    const refusals = (Array.isArray(messages) ? messages : [])
      .map(String)
      .filter((message) => message.includes('Content Security Policy'))
    const unread = refusals.filter(
      (message) => !pluginFrameCspBlock(message) && !isPluginFrameCancelledRequestEcho(message)
    )
    expect(unread).toEqual([])
    const origins = refusals.flatMap((message) => pluginFrameCspBlock(message)?.origin ?? [])
    expect(new Set(origins)).toEqual(
      new Set([
        'https://fonts.example.com',
        'https://cdn.example.com',
        'https://img.example.com',
        'https://frame.example.com',
        'https://media.example.com',
        'https://js.example.com',
        'https://api.example.com'
      ])
    )
  }, 60_000)
})
