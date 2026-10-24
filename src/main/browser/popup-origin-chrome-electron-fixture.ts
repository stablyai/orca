import { app, BaseWindow, BrowserWindow, WebContentsView } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openPopupWithOriginBar } from './popup-origin-bar-window'
import { prepareNativeBrowserPopup } from './browser-popup-native-window'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Popup identity probes require a background launch')
}
applyBackgroundActivationPolicy()

app.commandLine.appendSwitch('host-resolver-rules', 'MAP popup-error.invalid 127.0.0.1')
app.commandLine.appendSwitch('no-proxy-server')

const root = process.env.ORCA_POPUP_IDENTITY_ROOT
if (!root) {
  throw new Error('Missing probe root')
}
const statusPath = join(root, 'status.json')
const attachedSourceViews = new Set<WebContentsView>()
let active: Electron.WebContents | undefined
let presenter: BaseWindow | undefined
let parent: BrowserWindow
let kind = 'adopted'
let pageTitle: string | undefined

function trackPageTitle(contents: Electron.WebContents): void {
  pageTitle = undefined
  contents.on('page-title-updated', (_event, title) => {
    pageTitle = title
  })
}

function adoptedWindow(contents: Electron.WebContents): BaseWindow | undefined {
  return BaseWindow.getAllWindows().find((window) =>
    window.contentView.children.some(
      (view) => view instanceof WebContentsView && view.webContents === contents
    )
  )
}

async function command(input: {
  id: number
  kind?: string
  url?: string
  action: string
  stage?: string
}) {
  if (input.action === 'collect-garbage') {
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Popup lifetime checks require --js-flags=--expose-gc')
    }
    globalThis.gc()
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  if (input.action === 'kind') {
    kind = input.kind ?? 'adopted'
  }
  if (input.action === 'attach') {
    if (input.kind === 'native') {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      await window.loadURL(input.url ?? 'about:blank')
      prepareNativeBrowserPopup(window)
      active = window.webContents
      trackPageTitle(active)
      presenter = window
    } else {
      const sourceView = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      // Collecting the source view would destroy its contents even after adoption.
      attachedSourceViews.add(sourceView)
      const contents = sourceView.webContents
      contents.once('destroyed', () => attachedSourceViews.delete(sourceView))
      await contents.loadURL(input.url ?? 'about:blank')
      openPopupWithOriginBar(
        {
          webContents: contents,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
          show: false
        },
        'https://uncommitted.invalid/'
      )
      active = contents
      trackPageTitle(active)
      presenter = adoptedWindow(contents)
    }
  }
  if (input.action === 'block') {
    active?.on('will-navigate', (event, url) => {
      if (url.endsWith('/blocked')) {
        event.preventDefault()
      }
    })
  }
  if (input.action === 'navigate') {
    void active?.loadURL(input.url ?? 'about:blank').catch(() => {})
  }
  if (input.action === 'stop') {
    active?.stop()
  }
  if (input.action === 'close') {
    presenter?.close()
    active = undefined
    presenter = undefined
  }
  const bar = presenter?.contentView.children.find(
    (view) => view instanceof WebContentsView && view.webContents !== active
  )
  if (input.action === 'capture' && bar instanceof WebContentsView) {
    const artifacts = process.env.ORCA_POPUP_IDENTITY_ARTIFACT_DIR
    if (
      artifacts &&
      (input.stage === 'pending' || input.stage === 'committed' || input.stage === 'opaque-error')
    ) {
      mkdirSync(artifacts, { recursive: true })
      bar.webContents.debugger.attach('1.3')
      try {
        await bar.webContents.debugger.sendCommand('Page.enable')
        const screenshot = await bar.webContents.debugger.sendCommand('Page.captureScreenshot')
        writeFileSync(
          join(artifacts, `adopted-origin-${input.stage}.png`),
          Buffer.from(screenshot.data, 'base64')
        )
      } finally {
        bar.webContents.debugger.detach()
      }
    }
  }
  let barState: unknown = null
  if (bar instanceof WebContentsView) {
    barState = await bar.webContents
      .executeJavaScript(
        "({label: document.querySelector('#origin')?.textContent, insecure: document.body.classList.contains('insecure')})"
      )
      .catch(() => null)
  }
  writeFileSync(
    statusPath,
    JSON.stringify({
      id: input.id,
      electron: process.versions.electron,
      kind,
      title: presenter?.getTitle(),
      pageTitle,
      committedUrl: active?.mainFrame.url,
      committedOrigin: active?.mainFrame.origin,
      bar: barState,
      windowsHidden: BaseWindow.getAllWindows().every((window) => !window.isVisible())
    })
  )
}

app.whenReady().then(async () => {
  parent = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  parent.webContents.setWindowOpenHandler(() => {
    if (kind === 'native') {
      return { action: 'allow', overrideBrowserWindowOptions: { show: false } }
    }
    return {
      action: 'allow',
      createWindow: (options) => {
        const popup = openPopupWithOriginBar(
          { ...options, show: false },
          'https://uncommitted.invalid/'
        )
        active = popup.contentWebContents
        trackPageTitle(active)
        presenter = adoptedWindow(active)
        return active
      }
    }
  })
  parent.webContents.on('did-create-window', (window) => {
    active = window.webContents
    trackPageTitle(active)
    presenter = window
    prepareNativeBrowserPopup(window)
  })
  parent.webContents.on('console-message', (_event, _level, message) => {
    if (!message.startsWith('origin-probe:')) {
      return
    }
    void command(JSON.parse(message.slice('origin-probe:'.length))).catch((error) =>
      writeFileSync(statusPath, JSON.stringify({ error: String(error) }))
    )
  })
  await parent.loadURL('data:text/html,<title>Origin presenter probe</title>')
})
setTimeout(() => app.exit(1), 90_000).unref()
