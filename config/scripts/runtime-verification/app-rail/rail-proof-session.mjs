// A proof runs its own Vite fixture server and Chromium in an invocation-owned process group.
// ORCA_RAIL_PROOF_BROWSER overrides Chromium; FAIL=assert|server, HOLD=server|driver|body|teardown,
// SACRIFICE=1, HANG=vite-close and PGREP exercise failure and cancellation before publishing proof.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { registry } from 'playwright-core/lib/coreBundle'
import { createServer as createViteServer } from 'vite'
import { log, runInProofProcessGroup } from './rail-proof-process-group.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const SIGNAL_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function closeResource(label, close) {
  const controller = new AbortController()
  try {
    await Promise.race([
      Promise.resolve().then(close),
      delay(8_000, null, { signal: controller.signal }).then(() => {
        throw new Error('close timed out')
      })
    ])
    log(`teardown: ${label} closed`)
    return true
  } catch (error) {
    log(`teardown: ${label}: ${error.message}`)
    return false
  } finally {
    controller.abort()
  }
}

async function startChromium(profile) {
  const executable =
    process.env.ORCA_RAIL_PROOF_BROWSER ||
    registry.registry.findExecutable('chromium-headless-shell').executablePath()
  const driver = spawn(
    executable,
    [
      '--headless',
      '--no-sandbox',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let output = ''
  const endpoint = await new Promise((resolve, reject) => {
    driver.on('error', reject)
    driver.once('exit', (code, signal) => {
      log(`driver browser pid ${driver.pid} exited code ${code}, signal ${signal ?? 'none'}`)
      reject(new Error(`Chromium exited before opening DevTools: ${output}`))
    })
    driver.stderr.setEncoding('utf8').on('data', (chunk) => {
      output = (output + chunk).slice(-8000)
      const match = output.match(
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/
      )
      if (match) {
        resolve(match[1])
      }
    })
  })
  const browser = await chromium.connectOverCDP(endpoint)
  log(`driver browser pid ${driver.pid}, ${executable}, Chromium ${browser.version()}`)
  return browser
}

// A parent and a child, both ignoring SIGTERM, exercise escalation after the parent exits normally.
function sacrificialProcesses() {
  const child = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  const parent = `process.on('SIGTERM', () => {}); const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}]); console.log('[rail-proof] sacrificial parent', process.pid, 'child', child.pid); setInterval(() => {}, 1000)`
  spawn(process.execPath, ['-e', parent], { stdio: 'inherit' })
}

export async function runRailProof(name, body) {
  if (!process.connected || process.env.ORCA_RAIL_PROOF_WORKER !== '1') {
    await runInProofProcessGroup()
    return
  }
  process.chdir(repoRoot)
  let signalName
  let releaseHolds
  const cancelled = new Promise((resolve) => {
    releaseHolds = resolve
  })
  function cancel(signal) {
    if (!signalName) {
      signalName = signal
      log(`worker received ${signal}; joining proof teardown`)
      releaseHolds()
    }
  }
  process.on('message', ({ signal }) => cancel(signal))
  process.on('disconnect', () => cancel('SIGTERM'))
  for (const signal of Object.keys(SIGNAL_CODES)) {
    process.on(signal, () => cancel(signal))
  }

  async function holdAt(stage) {
    if (process.env.ORCA_RAIL_PROOF_HOLD === stage) {
      log(`holding at ${stage}`)
      await cancelled
    }
  }

  const tempDir = process.env.ORCA_RAIL_PROOF_TEMP
  let vite
  let browser
  let passed = false
  try {
    const identity = await Promise.all(
      [
        import.meta.filename,
        process.argv[1],
        path.join(import.meta.dirname, 'rail-proof-process-group.mjs')
      ].map(async (file) => `${path.basename(file)} ${sha256(await readFile(file))}`)
    )
    log(`${name}: worker pid ${process.pid}, source root ${repoRoot}; ${identity.join('; ')}`)
    if (process.env.ORCA_RAIL_PROOF_SACRIFICE === '1') {
      sacrificialProcesses()
    }
    if (signalName) {
      return
    }
    const server = createViteServer({
      configFile: path.join(repoRoot, 'config/vite.fixtures.config.ts'),
      cacheDir: path.join(tempDir, 'vite'),
      clearScreen: false,
      logLevel: 'warn',
      server: { host: '127.0.0.1', port: 0, open: false, hmr: false }
    }).then(async (created) => {
      vite = created
      if (process.env.ORCA_RAIL_PROOF_FAIL === 'server') {
        log('forcing fixture startup failure before listen')
        throw new Error('forced fixture startup failure')
      }
      await created.listen()
    })
    await Promise.all([server, holdAt('server')])
    if (signalName) {
      return
    }
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') {
      throw new Error('the fixture server has no TCP address')
    }
    const url = `http://127.0.0.1:${address.port}`
    log(`fixture server: pid ${process.pid} at ${url}, temp directory ${tempDir}`)

    const launching = startChromium(path.join(tempDir, 'chromium')).then((connected) => {
      browser = connected
    })
    await Promise.all([launching, holdAt('driver')])
    if (signalName) {
      return
    }
    if (process.env.ORCA_RAIL_PROOF_FAIL === 'assert') {
      throw new Error('forced assertion failure (ORCA_RAIL_PROOF_FAIL=assert)')
    }
    await holdAt('body')
    if (signalName) {
      return
    }

    const exercise = async () => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
      page.setDefaultTimeout(12_000)
      page.on('pageerror', (error) => console.error(`[page error] ${error.message}`))
      await body({ page, url, served: (paths) => servedSources(url, paths) })
      return true
    }
    passed = (await Promise.race([exercise(), cancelled])) === true
    if (passed) {
      log(`${name}: PASS`)
    }
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    log(`${name}: FAIL`)
  } finally {
    const closing = Promise.all([
      browser &&
        closeResource('driver browser', async () => {
          const connection = await browser.newBrowserCDPSession()
          await connection.send('Browser.close')
        }),
      vite &&
        closeResource('fixture server', () =>
          process.env.ORCA_RAIL_PROOF_HANG === 'vite-close' ? new Promise(() => {}) : vite.close()
        )
    ])
    await holdAt('teardown')
    const complete = (await closing).every((outcome) => outcome !== false)
    const code = complete ? (signalName ? SIGNAL_CODES[signalName] : passed ? 0 : 1) : 1
    // The supervisor owns group teardown, including any Chromium and Vite descendants still running here.
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
  }
}

/**
 * What this invocation's fixture server serves for these sources, so a result is bound to the code under test: the
 * hash of each on-disk file and of the module the server transforms from it.
 */
async function servedSources(url, paths) {
  const lines = []
  for (const relativePath of paths) {
    const disk = await readFile(path.join(repoRoot, 'src/renderer', relativePath), 'utf8')
    const response = await fetch(`${url}/${relativePath}`, { signal: AbortSignal.timeout(120_000) })
    const served = await response.text()
    if (!response.ok) {
      throw new Error(`fixture server could not serve ${relativePath}: ${response.status}`)
    }
    lines.push(
      `${relativePath}: disk sha256 ${sha256(disk)}, served sha256 ${sha256(served)} (${served.length} bytes)`
    )
  }
  return { lines }
}

/** Two animation frames: enough for React to commit and Radix to position. */
export function paint(page) {
  return page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

export async function renderFixture(page, url, name, theme, viewport) {
  if (viewport) {
    await page.setViewportSize(viewport)
  }
  if (page.url() === 'about:blank') {
    await page.goto(`${url}/fixtures.html?worker`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000
    })
    await page.evaluate(() => {
      window.__railProofFrames = {
        request: window.requestAnimationFrame.bind(window),
        cancel: window.cancelAnimationFrame.bind(window)
      }
    })
  }
  await page.evaluate(
    async ({ id, theme }) => {
      // Each fixture gets a fresh root and store. Restore the browser frame functions instrumented by a prior case.
      window.requestAnimationFrame = window.__railProofFrames.request
      window.cancelAnimationFrame = window.__railProofFrames.cancel
      await window.__orcaComponentFixtureHost.render(id, theme)
    },
    { id: `app-rail/AppRail:${name}`, theme }
  )
  await page.waitForFunction(() =>
    ['ready', 'error'].includes(document.documentElement.dataset.fixtureState ?? '')
  )
  const state = await page.getAttribute('html', 'data-fixture-state')
  if (state !== 'ready') {
    throw new Error(`fixture ${name} (${theme}) did not render: ${state}`)
  }
  await paint(page)
}
