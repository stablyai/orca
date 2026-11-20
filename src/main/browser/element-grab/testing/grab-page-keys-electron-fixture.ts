import type { KeybindingOverrides } from '../../../../shared/keybindings/types'
import { verifyGrabChordRefresh } from './grab-chord-refresh-electron-fixture'
import { verifyGrabSelectionReplacement } from './grab-selection-replacement-electron-fixture'
import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, webContents } from 'electron'
import { applyBackgroundActivationPolicy } from '../../../window/activation/foreground-activation-policy'
import {
  setupGrabShortcutForwarding,
  refreshGrabShortcutPolicies
} from '../../guest-lifecycle/input/shortcuts/browser-guest-grab-shortcuts'
import { withAgentInputInjection } from '../../cdp/input/agent-input-injection'

const PAGE = `<!doctype html><meta charset="utf-8"><title>Keys</title>
<form id="form"><input id="search"></form><button id="buy">Buy</button><div id="host"></div>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' });
root.innerHTML = '<textarea id="note"></textarea>';
window.__pageKeys = []; window.__submits = 0; document.getElementById('form').addEventListener('submit', e => { e.preventDefault(); window.__submits++ });
window.__copySeen = false; document.addEventListener('copy', e => { window.__copySeen = true; e.preventDefault(); });
document.addEventListener('keydown', (e) => window.__pageKeys.push(e.key), true);
</script>`

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function run(): Promise<void> {
  app.on('window-all-closed', () => {})
  const isolatedHome = process.env.HOME
  if (!isolatedHome) {
    throw new Error('Missing isolated home')
  }
  for (const name of ['home', 'appData', 'userData'] as const) {
    const path = name === 'home' ? isolatedHome : join(isolatedHome, name)
    mkdirSync(path, { recursive: true })
    app.setPath(name, path)
  }
  const { BrowserManager } = await import('../../guest-lifecycle/manager/browser-manager')
  applyBackgroundActivationPolicy()
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      webviewTag: true,
      backgroundThrottling: false
    }
  })
  window.webContents.on('will-attach-webview', (_event, preferences) => {
    preferences.preload = process.env.ORCA_BROWSER_GUEST_PRELOAD
    preferences.sandbox = true
    preferences.contextIsolation = true
    preferences.backgroundThrottling = false
  })
  const guestUrl = `data:text/html,${encodeURIComponent(PAGE)}`
  const hostHtml = `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}webview{width:100%;height:100%}</style><webview id="page" src="${guestUrl}"></webview>`
  await window.loadURL(`data:text/html,${encodeURIComponent(hostHtml)}`)
  const deadline = Date.now() + 10_000
  let guestId = 0
  while (!guestId) {
    guestId = await window.webContents.executeJavaScript(
      `(() => { try { return document.getElementById('page').getWebContentsId() } catch { return 0 } })()`
    )
    if (Date.now() > deadline) {
      throw new Error('Guest did not attach')
    }
    if (!guestId) {
      await wait(20)
    }
  }
  const page = webContents.fromId(guestId)
  if (!page) {
    throw new Error('Missing attached guest')
  }
  while (page.isLoading()) {
    if (Date.now() > deadline) {
      throw new Error('Guest did not load')
    }
    await wait(20)
  }
  const manager = new BrowserManager()
  const forwarded: string[] = []
  const chordPages: string[] = []
  const recorder = {
    id: window.webContents.id,
    on: window.webContents.on.bind(window.webContents),
    off: window.webContents.off.bind(window.webContents),
    isDestroyed: () => false,
    send: (channel: string, args: { key: string } | string) => {
      if (channel === 'browser:grabModeToggle' && typeof args === 'string') {
        chordPages.push(args)
      } else if (typeof args !== 'string') {
        forwarded.push(args.key)
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forwarder only calls send on the renderer, which this recorder implements.
  const renderer = recorder as unknown as Electron.WebContents
  let overrides: KeybindingOverrides | undefined
  setupGrabShortcutForwarding({
    getKeybindings: () => overrides,
    browserTabId: 'page-1',
    guest: page,
    resolveRenderer: () => renderer,
    hasActiveGrabOp: () => true
  })
  const evalPage = (code: string): Promise<unknown> => page.executeJavaScript(code)
  const press = async (key: string): Promise<void> => {
    page.sendInputEvent({ type: 'keyDown', keyCode: key })
    page.sendInputEvent({ type: 'char', keyCode: key })
    page.sendInputEvent({ type: 'keyUp', keyCode: key })
    await wait(80)
  }
  // A field focused before the pick stays focused when the picker arms.
  await evalPage(`document.getElementById('search').focus()`)
  await manager.setGrabMode('page-1', true, page, renderer)
  const focusAfterArm = await evalPage(`document.activeElement && document.activeElement.id`)
  await press('c')
  await press('d')
  const searchValue = await evalPage(`document.getElementById('search').value`)
  const forwardedWhileInField = [...forwarded]

  // Page script moves focus into a shadow-root field mid-pick.
  await evalPage(`document.getElementById('host').shadowRoot.getElementById('note').focus()`)
  await press('g')
  const noteValue = await evalPage(
    `document.getElementById('host').shadowRoot.getElementById('note').value`
  )

  await evalPage(
    `(() => { const host = document.createElement('div'); host.id = 'closed'; const input = document.createElement('input'); host.attachShadow({mode:'closed'}).append(input); document.body.append(host); window.__closedInput = input; input.focus() })()`
  )
  const beforeClosed = forwarded.length
  await press('d')
  const closedField = {
    value: await evalPage('window.__closedInput.value'),
    forwarded: forwarded.slice(beforeClosed)
  }

  // Page script can't see or replace the tracker (it lives in an isolated world).
  const trackerVisibleToPage = await evalPage(`typeof window.__orcaGrabNativeKeys !== 'undefined'`)

  // Tab into a field, then a letter at once: Tab makes the state unknown, so the letter types into the field.
  await evalPage(`document.getElementById('buy').focus()`)
  const beforeTab = forwarded.length
  page.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  page.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await press('g')
  const tabThenLetter = {
    focused: await evalPage(`document.activeElement && document.activeElement.id`),
    forwarded: forwarded.slice(beforeTab)
  }

  // Script refocus into a field, then a letter right away.
  await evalPage(`document.getElementById('buy').focus()`)
  const beforeScript = forwarded.length
  await evalPage(
    `document.getElementById('search').value = ''; document.getElementById('search').focus()`
  )
  // Two keys back to back: the first is held for the page's answer, the second must not overtake it.
  for (const key of ['s', 'a']) {
    page.sendInputEvent({ type: 'keyDown', keyCode: key })
    page.sendInputEvent({ type: 'char', keyCode: key })
    page.sendInputEvent({ type: 'keyUp', keyCode: key })
  }
  await wait(200)
  const scriptFocusThenLetter = {
    value: await evalPage(`document.getElementById('search').value`),
    forwarded: forwarded.slice(beforeScript)
  }

  // More holds to time: ten letters right after a script focus into the field, ten off fields.
  for (let i = 0; i < 10; i++) {
    await evalPage(`document.getElementById('buy').focus()`)
    await evalPage(`document.getElementById('search').focus()`)
    await press('s')
    await evalPage(`document.getElementById('buy').focus()`)
    await press('g')
  }

  // Focus leaves the fields (Tab or script to a button): letters are tools again and the page never sees them.
  await evalPage(`document.getElementById('buy').focus(); window.__pageKeys = []`)
  const beforeButton = forwarded.length
  await press('a')
  await press('g')
  await press('d')
  const pageSawToolKey = await evalPage(`window.__pageKeys.includes('a')`)
  const forwardedOnButton = forwarded.slice(beforeButton)

  await evalPage(`document.getElementById('buy').focus()`)
  const beforeAgent = forwarded.length
  await withAgentInputInjection(page, () => press('g'))
  const agentForwarded = forwarded.slice(beforeAgent)

  await evalPage('document.activeElement.blur()')
  const beforeBody = forwarded.length
  await press('d')
  const offFieldBody = forwarded.slice(beforeBody)

  // Alt pressed and released in the page during a pick: both edges reach the palette. (A key-up whose key-down
  // the page never saw is dropped before any handler, so the palette also releases when focus enters the page.)
  forwarded.length = 0
  page.sendInputEvent({ type: 'keyDown', keyCode: 'Alt', modifiers: ['alt'] })
  page.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' })
  await wait(80)
  const altEdges = forwarded.filter((key) => key.startsWith('alt'))

  const chord = async (key = 'C', shift = false): Promise<void> => {
    const modifiers: ('meta' | 'control' | 'shift')[] = [
      process.platform === 'darwin' ? 'meta' : 'control'
    ]
    if (shift) {
      modifiers.push('shift')
    }
    page.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
    page.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    await wait(80)
  }
  await evalPage(
    "document.getElementById('buy').focus();window.__copySeen=false;window.__pageKeys=[]"
  )
  await chord()
  const chordOffField = {
    pages: [...chordPages],
    pageSawChord: await evalPage("window.__pageKeys.some(key=>key.toLowerCase()==='c')"),
    copySeen: await evalPage('window.__copySeen')
  }
  chordPages.length = 0
  await evalPage(
    "const field=document.getElementById('search');field.value='synthetic';field.focus();field.select();window.__copySeen=false;window.__pageKeys=[]"
  )
  await chord()
  const chordInField = {
    pages: [...chordPages],
    pageSawChord: await evalPage("window.__pageKeys.some(key=>key.toLowerCase()==='c')")
  }

  const replacement = await verifyGrabSelectionReplacement(page, manager, forwarded, press)
  await manager.setGrabMode('page-1', true, page, renderer)

  await evalPage("document.getElementById('buy').focus();window.__pageKeys=[]")
  const selection = manager.awaitGrabSelection('page-1', 'cancel-from-page', page)
  while (!(await evalPage('Boolean(window.__orcaGrab?.cancelAwait)'))) {
    if (Date.now() > deadline + 10_000) {
      throw new Error('Selection did not start')
    }
    await wait(20)
  }
  await evalPage('window.__orcaGrab.cancelAwait()')
  const cancelled = await selection
  const beforeRetired = forwarded.length
  await press('g')
  const afterCancellation = {
    kind: cancelled.kind,
    forwarded: forwarded.slice(beforeRetired),
    pageSawKey: await evalPage("window.__pageKeys.includes('g')")
  }

  await manager.setGrabMode('page-1', false, page)
  const chordRefresh = await verifyGrabChordRefresh(page, chordPages, chord, () => {
    overrides = { 'browser.grabElement': ['Mod+Shift+G'] }
    refreshGrabShortcutPolicies()
  })

  process.stdout.write(
    `${JSON.stringify({
      focusAfterArm,
      searchValue,
      forwardedWhileInField,
      trackerVisibleToPage,
      tabThenLetter,
      scriptFocusThenLetter,
      noteValue,
      closedField,
      forwardedOnButton,
      offFieldBody,
      pageSawToolKey,
      altEdges,
      agentForwarded,
      chordOffField,
      chordInField,
      replacement,
      afterCancellation,
      chordRefresh
    })}\n`
  )
  process.stderr.write(
    `[palette-proof] ${JSON.stringify({
      pid: process.pid,
      environmentKeys: Object.keys(process.env).sort(),
      chordOffField,
      chordInField,
      replacement,
      afterCancellation,
      chordRefresh,
      children: app.getAppMetrics().map((metric) => ({ pid: metric.pid, type: metric.type })),
      home: app.getPath('home'),
      appData: app.getPath('appData'),
      userData: app.getPath('userData'),
      mainBundleSha256: createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'),
      preloadBundleSha256: createHash('sha256')
        .update(readFileSync(process.env.ORCA_BROWSER_GUEST_PRELOAD ?? ''))
        .digest('hex')
    })}\n`
  )
  window.destroy()
  app.exit(0)
}

run().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`)
  app.exit(1)
})
