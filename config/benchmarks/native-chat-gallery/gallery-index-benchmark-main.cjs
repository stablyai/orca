const { app, BrowserWindow, contentTracing } = require('electron')
const { createServer } = require('node:http')
const { readFile, mkdir, writeFile } = require('node:fs/promises')
const { resolve, join, relative, extname } = require('node:path')
const os = require('node:os')

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Gallery benchmark requires ORCA_BACKGROUND_LAUNCH=1')
}
const directory = resolve(
  process.env.ORCA_GALLERY_BENCH_OUTPUT ?? '.artifacts/gallery-index-benchmark'
)
app.setPath('userData', join(directory, `profile-${Date.now()}`))
if (process.platform === 'darwin') {
  app.setActivationPolicy('prohibited')
}

async function run() {
  await app.whenReady()
  const traceDirectory = join(directory, 'traces')
  await mkdir(traceDirectory, { recursive: true })
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const file = resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (relative(directory, file).startsWith('..')) {
        throw new Error('Invalid benchmark path')
      }
      response.setHeader(
        'Content-Type',
        extname(file) === '.html' ? 'text/html' : 'text/javascript'
      )
      response.end(await readFile(file))
    } catch {
      response.statusCode = 404
      response.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const errors = []
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      errors.push(details.message)
    }
  })
  const report = {
    head: process.env.ORCA_GALLERY_BENCH_HEAD ?? 'uncommitted',
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    cpu: os.cpus()[0]?.model,
    ramBytes: os.totalmem(),
    load: os.loadavg(),
    versions: process.versions,
    scope:
      'Non-UI worker fixture; no dialog shell, native keyboard routing or closed-transcript render baseline is claimed',
    cases: [],
    errors
  }
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`)
    window.webContents.debugger.attach('1.3')
    const workloads = [
      { name: '2000-cold-and-same-worker-warm', options: { count: 2000, warm: true } },
      { name: 'single-row-update-after-ready', options: { count: 2000, warm: true, update: true } },
      { name: 'large-unrelated-tool-input', options: { count: 1, largeTool: true, warm: true } },
      { name: '100k-image', options: { count: 1, giant: true, image: true, warm: true } },
      { name: '100k-text', options: { count: 1, giant: true, image: false, warm: true } },
      { name: 'oversized-image-fields', options: { count: 1, largeFields: true, warm: true } },
      { name: 'large-image-result', options: { count: 1, manyImages: true, warm: true } },
      { name: 'close-during-index', options: { count: 2000, cancel: true } },
      { name: 'rapid-stream-revisions', options: { count: 2000, stream: true } },
      { name: 'repeat-open-close', options: { count: 2000, repeat: 3 } },
      { name: 'reopen-new-worker-cold-index', options: { count: 2000 } }
    ]
    for (const { name, options } of workloads) {
      await contentTracing.startRecording({
        included_categories: [
          'devtools.timeline',
          'blink.user_timing',
          'toplevel',
          'v8',
          'disabled-by-default-devtools.timeline'
        ]
      })
      const trace = join(traceDirectory, `${name}.json`)
      try {
        const pending = window.webContents.executeJavaScript(
          `window.runGalleryBenchmark(${JSON.stringify(options)})`
        )
        const inputProbe = new Promise((resolve) => {
          setTimeout(async () => {
            const started = performance.now()
            try {
              await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: 'Escape',
                code: 'Escape',
                windowsVirtualKeyCode: 27
              })
              resolve({ cdpRoundTripMs: performance.now() - started })
            } catch (error) {
              resolve({ error: String(error) })
            }
          }, 50)
        })
        const result = await pending
        const input = await inputProbe
        const heapUsage = await window.webContents.debugger.sendCommand('Runtime.getHeapUsage')
        const targets = await window.webContents.debugger.sendCommand('Target.getTargets')
        const targetCounts = {}
        for (const target of targets.targetInfos) {
          targetCounts[target.type] = (targetCounts[target.type] ?? 0) + 1
        }
        report.cases.push({
          name,
          options,
          result,
          input,
          trace,
          targetCounts,
          heapUsage,
          processes: app.getAppMetrics()
        })
        console.log(JSON.stringify({ name, result }))
      } finally {
        await contentTracing.stopRecording(trace)
      }
    }
  } finally {
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
    window.destroy()
    server.close()
    app.quit()
  }
}

run().catch((error) => {
  console.error(error)
  app.exit(1)
})
