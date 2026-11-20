import { app, BrowserWindow } from 'electron'
import { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'

// A page that is one flat colour everywhere: any other pixel in a capture is the picker's highlight or label.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Flat</title>
<style>html,body{margin:0;height:100%;background:#ff0000;overflow:hidden}
#target{position:absolute;left:200px;top:150px;width:160px;height:60px;background:#ff0000;border:0;padding:0}</style>
<button id="target" aria-label="Target"></button>`

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function run(): Promise<void> {
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 400,
    paintWhenInitiallyHidden: true,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })
  const page = window.webContents
  await page.loadURL(`data:text/html,${encodeURIComponent(PAGE)}`)
  const manager = new BrowserManager()
  const center = { x: 280, y: 180 }
  const pickedKinds: string[] = []

  const offColourPixels = async (): Promise<number> => {
    const bitmap = (await page.capturePage()).toBitmap()
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
      // Challenge: the page's main thread is busy 40ms of every 50, so teardown and painting run late.
      await page.executeJavaScript(
        `setInterval(() => { const end = performance.now() + 40; while (performance.now() < end) {} }, 50); true`
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
    await manager.setGrabMode('page-1', false, page)
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
    await manager.setGrabMode('page-1', false, page)
    results[`confirming-${load}`] = {
      overlayVisibleBefore: before2,
      offColourAfterTeardown: await offColourPixels()
    }
  }

  process.stdout.write(`${JSON.stringify({ pickedKinds, ...results })}\n`)
  window.destroy()
  app.exit(0)
}

run().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`)
  app.exit(1)
})
