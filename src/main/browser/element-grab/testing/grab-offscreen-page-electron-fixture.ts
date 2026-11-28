import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { applyBackgroundActivationPolicy } from '../../../window/activation/foreground-activation-policy'
import { writeElectronFixtureResult } from '../../electron-fixtures/electron-fixture-result'

const PAGE = `<!doctype html><meta charset="utf-8"><title>Serve</title>
<style>html,body{margin:0}#buy{position:absolute;left:100px;top:100px;width:120px;height:40px}</style>
<button id="buy">Buy</button>`

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A serve page: an offscreen window with the offscreen page preload, as `orca serve` renders it. */
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
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      preload: process.env.ORCA_BROWSER_OFFSCREEN_PRELOAD
    }
  })
  await window.loadURL(`data:text/html,${encodeURIComponent(PAGE)}`)
  const page = window.webContents
  const manager = new BrowserManager()
  const awaiting = async (): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (
      !(await page.executeJavaScript(
        "Boolean(document.getElementById('__orca-grab-host')?.hasAttribute('data-orca-grab-awaiting'))"
      ))
    ) {
      if (Date.now() > deadline) {
        throw new Error('Selection did not start')
      }
      await wait(20)
    }
  }

  const firstArm = await manager.setGrabMode('page-1', true, page)
  const firstWait = manager.awaitGrabSelection('page-1', 'first', page)
  await awaiting()
  // The viewer re-arms while the first wait is outstanding: the replacement picker must stay live.
  const replacementArm = await manager.setGrabMode('page-1', true, page)
  const first = await firstWait
  const pick = manager.awaitGrabSelection('page-1', 'replacement', page)
  await awaiting()
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp'] as const) {
    page.sendInputEvent({ type, x: 160, y: 120, button: 'left', clickCount: 1 })
    await wait(30)
  }
  const picked = await pick
  await writeElectronFixtureResult({
    firstArm,
    replacementArm,
    firstWait: first.kind,
    pick: {
      kind: picked.kind,
      target: picked.kind === 'selected' ? picked.payload.target.tagName : null
    }
  })
  window.destroy()
  app.exit(0)
}

run().catch((error: unknown) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`)
  app.exit(1)
})
