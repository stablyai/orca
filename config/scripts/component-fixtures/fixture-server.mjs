// Share detached Vite/headless Chromium between fixtures-shot.mjs and the fixtures MCP server.
import { existsSync, rmSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { createServer as createViteServer } from 'vite'
import { createFixturePageRunner } from './fixture-page-runner.mjs'
import {
  fixtureCacheDir,
  fixtureServerCodeStamp,
  matchFixtureIds,
  repoRoot,
  serverGuardPath,
  serverStatePath
} from './fixture-paths.mjs'
import { SERVER_BUSY_EXIT_CODE, tryHoldLock } from './fixture-locks.mjs'

const fixtureRegistryPath = path
  .join(repoRoot, 'src/renderer/src/component-fixtures/component-fixture-registry.ts')
  .replaceAll('\\', '/')
const codeStamp = fixtureServerCodeStamp()
const IDLE_SHUTDOWN_MS = Number(process.env.ORCA_FIXTURES_IDLE_MS) || 20 * 60 * 1000
const STOP_GRACE_MS = 10_000
// Covers a predecessor's teardown, which its own watchdog bounds by STOP_GRACE_MS.
const GUARD_WAIT_MS = 20_000
// Module scope keeps the guard connection open; a collected connection would drop the lock.
let serverGuard = null
let browserPromise = Promise.resolve(null)
// Set as soon as the browser process exists, so retirement never waits on connect().
let launchedServer = null
const CONNECT_TIMEOUT_MS = 30_000

process.chdir(repoRoot)

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

// Prefers an explicit binary, then the Playwright-managed headless shell, then an
// installed Chrome/Edge. Every option runs headless, so no window or focus change.
async function launchHeadlessBrowser() {
  const override = process.env.ORCA_FIXTURES_BROWSER
  const attempts = [
    ...(override ? [{ label: override, options: { executablePath: override } }] : []),
    { label: 'playwright chromium-headless-shell', options: {} },
    { label: 'installed Chrome', options: { channel: 'chrome' } },
    { label: 'installed Edge', options: { channel: 'msedge' } }
  ]
  const failures = []
  for (const attempt of attempts) {
    try {
      // Why a browser server: process() is a handle whose exit can be confirmed on every platform.
      // Why handleSIG* off: stop() owns signals, so no signal closes the browser under this server.
      const server = await chromium.launchServer({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        ...attempt.options
      })
      launchedServer = server
      const browser = await chromium
        .connect(server.wsEndpoint(), { timeout: CONNECT_TIMEOUT_MS })
        .catch(async (error) => {
          await server.kill()
          throw error
        })
      console.log(`[fixtures] browser: ${attempt.label}`)
      return { server, browser }
    } catch (error) {
      failures.push(`${attempt.label}: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
  throw new Error(
    `No headless Chromium found. Set ORCA_FIXTURES_BROWSER or run \`pnpm exec playwright install chromium-headless-shell\`.\n${failures.join('\n')}`
  )
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(value))
}

async function handleShot(runner, body) {
  const patterns = Array.isArray(body.ids) ? body.ids : [body.ids].filter(Boolean)
  const themes =
    body.theme === 'both' ? ['dark', 'light'] : [body.theme === 'light' ? 'light' : 'dark']
  const scale = Number(body.scale) > 0 ? Number(body.scale) : 1
  const outDir = body.outDir || fixtureCacheDir
  // Why: exact ids skip listing, which would import every fixture module after an edit.
  const exact = patterns.every((pattern) => pattern.includes(':') && !pattern.includes('*'))
  const knownIds = exact ? patterns : (await runner.listFixtures()).map((entry) => entry.id)
  const ids = [...new Set(patterns.flatMap((pattern) => matchFixtureIds(knownIds, pattern)))]
  if (ids.length === 0) {
    return { results: [], error: `No fixture matches ${patterns.join(', ')}.`, knownIds }
  }
  await mkdir(outDir, { recursive: true })
  const results = []
  for (const id of ids) {
    for (const theme of themes) {
      results.push(await runner.screenshotFixture(id, theme, scale, outDir))
    }
  }
  return { results }
}

async function routeFixtureRequest(req, res, session) {
  const { runner } = session
  if (req.url === '/__fixtures/health') {
    // Why stopping: the retiring server keeps its endpoint so clients can wait for it to exit.
    sendJson(res, 200, { ok: true, pid: process.pid, codeStamp, stopping: session.stopping })
  } else if (req.url === '/__fixtures/stop' && req.method === 'POST') {
    session.stop()
    sendJson(res, 200, { ok: true })
  } else if (session.stopping) {
    sendJson(res, 503, { error: 'Fixture server is stopping.' })
  } else if (req.url === '/__fixtures/list') {
    sendJson(res, 200, { fixtures: await runner.listFixtures() })
  } else if (req.url === '/__fixtures/shot' && req.method === 'POST') {
    sendJson(res, 200, await handleShot(runner, await readJsonBody(req)))
  } else {
    sendJson(res, 404, { error: `Unknown fixture endpoint ${req.url}` })
  }
}

// With HMR off, fixture additions/deletions must invalidate the registry's import.meta.glob.
function invalidateFixtureRegistry(server) {
  const registryModules = server.moduleGraph.getModulesByFile(fixtureRegistryPath)
  for (const module of registryModules ?? []) {
    server.moduleGraph.invalidateModule(module)
  }
}

function createFixtureApiPlugin(session) {
  return {
    name: 'orca-component-fixture-api',
    configureServer(server) {
      // Any watched source change makes the warm page reload before its next shot.
      server.watcher.on('all', (event, file) => {
        if ((event === 'add' || event === 'unlink') && file.endsWith('.fixture.tsx')) {
          invalidateFixtureRegistry(server)
        }
        session.runner?.markSourceChanged()
      })
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/__fixtures/')) {
          next()
          return
        }
        session.lastActivity = Date.now()
        if (!session.runner) {
          sendJson(res, 503, { error: 'Fixture browser is still starting.' })
          return
        }
        routeFixtureRequest(req, res, session).catch((error) => {
          sendJson(res, 500, { error: String(error?.message ?? error) })
        })
      })
    }
  }
}

// Exits only once the browser process is confirmed gone. Until then this process keeps the
// server guard, so a successor waits for it (or gives up) instead of starting beside it.
async function exitAfterBrowser(browserPromise, code) {
  const child = (launchedServer ?? (await browserPromise.catch(() => null))?.server)?.process()
  if (child) {
    while (child.exitCode === null && child.signalCode === null) {
      try {
        // Why process.kill: child.kill() marks the child killed, which makes Playwright's own
        // exit-time cleanup skip it. On POSIX the browser leads its own process group.
        process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      await delay(100)
    }
  }
  if (process.env.ORCA_FIXTURES_CANCEL_FILE) {
    rmSync(process.env.ORCA_FIXTURES_CANCEL_FILE, { force: true })
  }
  process.exit(code)
}

async function main() {
  await mkdir(fixtureCacheDir, { recursive: true })
  // One server per checkout: held until this process exits, so a successor cannot start
  // until this one, crashed or not, is gone.
  serverGuard = tryHoldLock(serverGuardPath, GUARD_WAIT_MS)
  if (!serverGuard) {
    console.error('[fixtures] another fixture server owns this checkout')
    rmSync(process.env.ORCA_FIXTURES_CANCEL_FILE ?? '', { force: true })
    process.exit(SERVER_BUSY_EXIT_CODE)
  }
  const port = await findFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  // Why parallel: browser launch and Vite startup are independent cold costs.
  browserPromise = launchHeadlessBrowser()
  browserPromise.catch(() => {})
  const session = { runner: null, lastActivity: Date.now(), stopping: false, stop: () => {} }
  let idleTimer
  let vitePromise = Promise.resolve(null)
  const stop = async () => {
    if (session.stopping) {
      return
    }
    // Why first: health must stop admitting this server before its browser starts closing.
    session.stopping = true
    clearInterval(idleTimer)
    // Why: a successor waits for this process to exit, so teardown cannot hang.
    setTimeout(() => void exitAfterBrowser(browserPromise, 0), STOP_GRACE_MS).unref()
    // Leave the last endpoint for the client to probe. A successor may already own it.
    try {
      await (await browserPromise.catch(() => null))?.server.close()
      await (await vitePromise.catch(() => null))?.close()
    } catch (error) {
      console.error(`[fixtures] stop failed: ${error?.stack ?? error}`)
    }
    await exitAfterBrowser(browserPromise, 0)
  }
  session.stop = () => void stop()
  // Signals are ours from launch on, so cancelling a startup runs the same teardown as stop.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, session.stop)
  }
  // Why: Vite adds SIGTERM and stdin-end handlers that exit before the browser is closed. It
  // adds them before createServer resolves and again on every restart, so for this process's
  // whole life drop any foreign one as soon as it is added ('newListener' fires before the add).
  process.on('newListener', (event, listener) => {
    if (event === 'SIGTERM' && listener !== session.stop) {
      queueMicrotask(() => process.off('SIGTERM', listener))
    }
  })
  process.stdin.on('newListener', (event, listener) => {
    if (event === 'end') {
      queueMicrotask(() => process.stdin.off('end', listener))
    }
  })
  // Why a file: on Windows a client cannot signal this process into its teardown, so a client
  // that gives up on it asks through this file instead (POSIX clients also send SIGTERM).
  // The path is unique to this start, so a request already there is consumed, not stale.
  const cancelPath = process.env.ORCA_FIXTURES_CANCEL_FILE
  setInterval(() => {
    if (cancelPath && existsSync(cancelPath)) {
      rmSync(cancelPath, { force: true })
      session.stop()
    }
  }, 200).unref()
  vitePromise = createViteServer({
    configFile: 'config/vite.fixtures.config.ts',
    clearScreen: false,
    logLevel: 'warn',
    // Why no HMR: the runner reloads its page on change, so pushed updates would only race it.
    server: { port, strictPort: true, host: '127.0.0.1', open: false, hmr: false },
    plugins: [createFixtureApiPlugin(session)]
  })
  const vite = await vitePromise
  await vite.listen()
  const { browser } = await browserPromise
  // Never publish a server that is stopping or whose browser is already gone.
  if (session.stopping) {
    return
  }
  if (!browser.isConnected()) {
    throw new Error('Fixture browser disconnected during startup.')
  }
  idleTimer = setInterval(() => {
    if (Date.now() - session.lastActivity > IDLE_SHUTDOWN_MS) {
      void stop()
    }
  }, 30_000)
  session.runner = createFixturePageRunner(
    baseUrl,
    browserPromise.then((launched) => launched.browser)
  )

  const pendingState = `${serverStatePath}.${process.pid}.tmp`
  await writeFile(pendingState, JSON.stringify({ pid: process.pid, port, url: baseUrl, codeStamp }))
  await rename(pendingState, serverStatePath).catch((error) => {
    rmSync(pendingState, { force: true })
    throw error
  })
  console.log(`[fixtures] ready at ${baseUrl}/fixtures.html`)
}

main().catch(async (error) => {
  console.error(`[fixtures] server failed: ${error?.stack ?? error}`)
  await exitAfterBrowser(browserPromise, 1)
})
