import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, webContents, nativeImage } from 'electron'
import { applyBackgroundActivationPolicy } from '../../../window/activation/foreground-activation-policy'
import { writeElectronFixtureResult } from '../../electron-fixtures/electron-fixture-result'
import { letFixtureWindowPaint } from '../../electron-fixtures/electron-fixture-window'
import { verifyGrabPickLifetime } from './grab-pick-lifetime-electron-fixture'
import { verifyGrabExecutionRecovery } from './grab-execution-recovery-electron-fixture'

// A page that is one flat colour everywhere: any other pixel in a capture is the picker's highlight or label.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Flat</title>
<style>html,body{margin:0;height:100%;background:#ff0000;overflow:hidden}
#target{position:absolute;left:200px;top:150px;width:160px;height:60px;background:#ff0000;border:0;padding:0}</style>
<button id="target" aria-label="Target"></button>`

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
    width: 640,
    height: 400,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      webviewTag: true,
      backgroundThrottling: false
    }
  })
  letFixtureWindowPaint(window)
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
  const foundPage = webContents.fromId(guestId)
  if (!foundPage) {
    throw new Error('Missing attached guest')
  }
  const page = foundPage
  while (page.isLoading()) {
    if (Date.now() > deadline) {
      throw new Error('Guest did not load')
    }
    await wait(20)
  }
  const manager = new BrowserManager()
  const recovery = await verifyGrabExecutionRecovery(page, manager, PAGE)
  const pickLifetime = await verifyGrabPickLifetime(page, manager, PAGE)
  const center = { x: 280, y: 180 }
  const pickedKinds: string[] = []

  const offColourPixels = async (): Promise<number> => {
    const dataUrl: string = await window.webContents.executeJavaScript(
      `document.getElementById('page').capturePage().then(image => image.toDataURL())`
    )
    const bitmap = nativeImage.createFromDataURL(dataUrl).toBitmap()
    let off = 0
    // BGRA; tolerate compression-free rounding only.
    for (let i = 0; i < bitmap.length; i += 4) {
      if (!(bitmap[i] < 8 && bitmap[i + 1] < 8 && bitmap[i + 2] > 247)) {
        off++
      }
    }
    return off
  }
  const hover = async (): Promise<void> => {
    for (const dx of [0, 4, 8]) {
      page.sendInputEvent({ type: 'mouseMove', x: center.x + dx, y: center.y })
      await wait(30)
    }
    await wait(150)
  }

  const results: Record<string, { overlayVisibleBefore: number; offColourAfterTeardown: number }> =
    {}
  for (const load of ['idle', 'busy'] as const) {
    if (load === 'busy') {
      // Challenge: the page's main thread is busy 45ms of every 50, so teardown and painting run late.
      await page.executeJavaScript(
        `setInterval(() => { const end = performance.now() + 45; while (performance.now() < end) {} }, 50); true`
      )
    }
    await runStates(load)
  }
  async function runStates(load: 'idle' | 'busy'): Promise<void> {
    // Awaiting: a pick is running and the hovered element is highlighted.
    await manager.setGrabMode('page-1', true, page)
    const awaiting = manager.awaitGrabSelection('page-1', `awaiting-${load}`, page)
    await hover()
    const before1 = await offColourPixels()
    if (!(await manager.setGrabMode('page-1', false, page))) {
      throw new Error('Clean teardown was not established')
    }
    results[`awaiting-${load}`] = {
      overlayVisibleBefore: before1,
      offColourAfterTeardown: await offColourPixels()
    }
    await awaiting

    // Confirming: the element was clicked; its highlight stays frozen while the card would be shown.
    await manager.setGrabMode('page-1', true, page)
    const confirming = manager.awaitGrabSelection('page-1', `confirming-${load}`, page)
    await hover()
    page.sendInputEvent({
      type: 'mouseDown',
      x: center.x,
      y: center.y,
      button: 'left',
      clickCount: 1
    })
    page.sendInputEvent({
      type: 'mouseUp',
      x: center.x,
      y: center.y,
      button: 'left',
      clickCount: 1
    })
    const picked = await confirming
    pickedKinds.push(picked.kind)
    await wait(150)
    const before2 = await offColourPixels()
    if (!(await manager.setGrabMode('page-1', false, page))) {
      throw new Error('Clean teardown was not established')
    }
    results[`confirming-${load}`] = {
      overlayVisibleBefore: before2,
      offColourAfterTeardown: await offColourPixels()
    }
  }

  await writeElectronFixtureResult({ pickedKinds, recovery, pickLifetime, ...results })
  process.stderr.write(
    `[palette-proof] ${JSON.stringify({
      pid: process.pid,
      versions: process.versions,
      environmentKeys: Object.keys(process.env).sort(),
      recovery,
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
