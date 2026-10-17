import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { build } from 'vite'
import { runProcess } from '../../shared/child-process/run-process'

it('captures fixture pixels from a real backend-owned hidden page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-offscreen-capture-'))
  try {
    const entry = join(root, 'entry.ts')
    const registry = join(root, 'registry.ts')
    const resultPath = join(root, 'result.json')
    writeFileSync(
      registry,
      `export const browserSessionRegistry = {
      getDefaultProfile: () => ({ id: 'capture', partition: 'persist:capture-fixture' }),
      getProfile: () => null
    }`
    )
    writeFileSync(
      entry,
      `
      export { OffscreenBrowserBackend } from ${JSON.stringify(resolve('src/main/browser/offscreen-browser-backend.ts'))}
    `
    )
    await build({
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [{ find: './browser-session-registry', replacement: registry }]
      },
      build: {
        emptyOutDir: false,
        outDir: root,
        target: 'node20',
        lib: { entry, formats: ['cjs'], fileName: () => 'backend.cjs' },
        rollupOptions: { external: ['electron', /^node:/] }
      }
    })
    const main = join(root, 'main.cjs')
    writeFileSync(
      main,
      `
      const { app, BrowserWindow, webContents, nativeImage } = require('electron')
      const { createServer } = require('node:http')
      const { writeFileSync } = require('node:fs')
      const { OffscreenBrowserBackend } = require('./backend.cjs')
      const resultPath = ${JSON.stringify(resultPath)}
      app.on('window-all-closed', () => {})
      const deadline = setTimeout(() => {
        writeFileSync(resultPath, JSON.stringify({ error: 'fixture timed out' }))
        app.exit(1)
      }, 30000)
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<body style="margin:0;background:rgb(0,255,255)"><div style="width:200px;height:200px;background:rgb(255,0,0)"></div><h1>CAPTURE FIXTURE</h1></body>')
      })
      let backend
      async function run() {
        await app.whenReady()
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        backend = new OffscreenBrowserBackend({
          registerOffscreenGuest: () => true,
          unregisterGuest: () => {}
        })
        const { browserPageId } = await backend.createTab({
          worktreeId: 'capture-workspace',
          url: 'http://127.0.0.1:' + server.address().port
        })
        const wc = webContents.fromId(backend.getWebContentsId(browserPageId))
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('page load timed out')), 10000)
          wc.once('did-finish-load', () => { clearTimeout(timer); resolve() })
        })
        if (!(await wc.executeJavaScript('document.body.innerText')).includes('CAPTURE FIXTURE')) {
          throw new Error('fixture DOM missing')
        }
        const window = BrowserWindow.fromWebContents(wc)
        const hidden = !window.isVisible()
        const offscreen = wc.isOffscreen()
        wc.debugger.attach('1.3')
const { data } = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
        const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
        const bitmap = image.toBitmap()
        let redPixels = 0
        let cyanPixels = 0
        for (let i = 0; i < bitmap.length; i += 4) {
          const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2], a = bitmap[i + 3]
          if (a > 240 && r > 240 && g < 15 && b < 15) redPixels++
          if (a > 240 && r < 15 && g > 240 && b > 240) cyanPixels++
        }
        wc.debugger.detach()
        await backend.closeTab(browserPageId)
        writeFileSync(resultPath, JSON.stringify({
          hidden, offscreen, size: image.getSize(), redPixels, cyanPixels,
          destroyed: window.isDestroyed(), retired: backend.getWebContentsId(browserPageId) === null
        }))
      }
      run().then(async () => {
        await backend.destroyAll()
        await new Promise(resolve => server.close(resolve))
        clearTimeout(deadline)
        app.exit(0)
      }).catch(async error => {
        writeFileSync(resultPath, JSON.stringify({ error: String(error.stack || error) }))
        await backend?.destroyAll()
        server.close()
        clearTimeout(deadline)
        app.exit(1)
      })
    `
    )
    const electronBinary: string = createRequire(import.meta.url)('electron')
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
    const electronArgs = [main, `--user-data-dir=${join(root, 'profile')}`]
    const run = await runProcess({
      program: process.platform === 'linux' ? 'xvfb-run' : electronBinary,
      args:
        process.platform === 'linux'
          ? ['--auto-servernum', electronBinary, ...electronArgs, '--no-sandbox']
          : electronArgs,
      env: { ...env, ORCA_BACKGROUND_LAUNCH: '1', HOME: root },
      timeoutMs: 60000
    })
    expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0)
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    expect(result).toMatchObject({ hidden: true, destroyed: true, retired: true })
    expect(result.size.width).toBeGreaterThanOrEqual(1000)
    expect(result.size.height).toBeGreaterThanOrEqual(600)
    expect(result.redPixels).toBeGreaterThan(10000)
    expect(result.cyanPixels).toBeGreaterThan(10000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120000)
