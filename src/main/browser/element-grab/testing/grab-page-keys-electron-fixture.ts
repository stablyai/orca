import { app, BrowserWindow } from 'electron'
import { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'
import { setupGrabShortcutForwarding } from '../../guest-lifecycle/input/shortcuts/browser-guest-grab-shortcuts'
import { askGuestHasField } from '../grab-guest-editable-watch'

const PAGE = `<!doctype html><meta charset="utf-8"><title>Keys</title>
<input id="search"><button id="buy">Buy</button><div id="host"></div>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' });
root.innerHTML = '<textarea id="note"></textarea>';
window.__pageKeys = [];
document.addEventListener('keydown', (e) => window.__pageKeys.push(e.key), true);
</script>`

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function run(): Promise<void> {
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const page = window.webContents
  await page.loadURL(`data:text/html,${encodeURIComponent(PAGE)}`)
  page.focus()
  const manager = new BrowserManager()
  const forwarded: string[] = []
  const recorder = {
    send: (_channel: string, args: { key: string }) => forwarded.push(args.key)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the forwarder only calls send on the renderer, which this recorder implements.
  const renderer = recorder as unknown as Electron.WebContents
  setupGrabShortcutForwarding({
    browserTabId: 'page-1',
    guest: page,
    resolveRenderer: () => renderer,
    hasActiveGrabOp: () => true,
    isGuestEditableFocused: (tabId) => manager.isGuestEditableFocused(tabId),
    markGuestFocusUnknown: (tabId) => manager.markGuestFocusUnknown(tabId),
    askPageHasField: () => askGuestHasField(page)
  })
  const evalPage = (code: string): Promise<unknown> => page.executeJavaScript(code)
  const press = async (key: string): Promise<void> => {
    page.sendInputEvent({ type: 'keyDown', keyCode: key })
    page.sendInputEvent({ type: 'char', keyCode: key })
    page.sendInputEvent({ type: 'keyUp', keyCode: key })
    await wait(80)
  }
  const settleEditable = async (expected: boolean): Promise<boolean> => {
    for (let i = 0; i < 50 && manager.isGuestEditableFocused('page-1') !== expected; i++) {
      await wait(20)
    }
    return manager.isGuestEditableFocused('page-1')
  }

  // A field focused before the pick stays focused when the picker arms.
  await evalPage(`document.getElementById('search').focus()`)
  await manager.setGrabMode('page-1', true, page)
  const focusAfterArm = await evalPage(`document.activeElement && document.activeElement.id`)
  const editableAtArm = await settleEditable(true)
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

  // Page script can't see or replace the tracker (it lives in an isolated world).
  const trackerVisibleToPage = await evalPage(`typeof window.__orcaEditableWatch !== 'undefined'`)

  // Tab into a field, then a letter at once: Tab makes the state unknown, so the letter types into the field.
  await evalPage(`document.getElementById('buy').focus()`)
  await settleEditable(false)
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
  await settleEditable(false)
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

  // Focus leaves the fields (Tab or script to a button): letters are tools again and the page never sees them.
  await evalPage(`document.getElementById('buy').focus(); window.__pageKeys = []`)
  const editableOnButton = await settleEditable(false)
  const beforeButton = forwarded.length
  await press('a')
  const pageSawToolKey = await evalPage(`window.__pageKeys.includes('a')`)
  const forwardedOnButton = forwarded.slice(beforeButton)

  // Alt pressed and released in the page during a pick: both edges reach the palette. (A key-up whose key-down
  // the page never saw is dropped before any handler, so the palette also releases when focus enters the page.)
  forwarded.length = 0
  page.sendInputEvent({ type: 'keyDown', keyCode: 'Alt', modifiers: ['alt'] })
  page.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' })
  await wait(80)
  const altEdges = forwarded.filter((key) => key.startsWith('alt'))

  await manager.setGrabMode('page-1', false, page)
  const editableAfterOff = manager.isGuestEditableFocused('page-1')

  process.stdout.write(
    `${JSON.stringify({
      focusAfterArm,
      editableAtArm,
      searchValue,
      forwardedWhileInField,
      trackerVisibleToPage,
      tabThenLetter,
      scriptFocusThenLetter,
      noteValue,
      editableOnButton,
      forwardedOnButton,
      pageSawToolKey,
      altEdges,
      editableAfterOff
    })}\n`
  )
  window.destroy()
  app.exit(0)
}

run().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`)
  app.exit(1)
})
