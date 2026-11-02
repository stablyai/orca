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
// console lines this Electron prints for them.
const PAGE = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>@font-face{font-family:x;src:url(https://fonts.example.com/a.woff2)}body{font-family:x}</style>
<link rel="stylesheet" href="https://cdn.example.com/a.css"></head><body>x
<img src="https://img.example.com/a.png"><iframe src="https://frame.example.com/"></iframe>
<video src="https://media.example.com/a.mp4"></video><script src="https://js.example.com/a.js"></script>
<script>fetch('https://api.example.com/x').catch(function () {})</script></body></html>`

const MAIN = String.raw`
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
const resultPath = join(dirname(process.argv[process.argv.length - 2]), 'result.json')
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, focusable: false })
  const messages = []
  // Why a count, not a timer: the seven refusals plus fetch's echo are all this page prints.
  win.webContents.on('console-message', (event) => {
    messages.push(event.message)
    if (messages.filter((m) => m.includes('Content Security Policy')).length === 8) {
      writeFileSync(resultPath, JSON.stringify({ messages }))
      app.exit(0)
    }
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
    writeFileSync(join(root, 'config.json'), '{}')

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
