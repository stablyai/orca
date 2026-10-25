// Long-lived dev server for component fixtures: Vite + one headless Chromium.
// Started (detached) and reused by fixtures-shot.mjs and the fixtures MCP server.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { createServer as createViteServer } from 'vite'
import { createFixturePageRunner } from './fixture-page-runner.mjs'
import {
  fixtureCacheDir,
  fixtureServerCodeStamp,
  matchFixtureIds,
  repoRoot,
  serverLockPath,
  serverStatePath
} from './fixture-paths.mjs'

const fixtureRegistryPath = path
  .join(repoRoot, 'src/renderer/src/component-fixtures/component-fixture-registry.ts')
  .replaceAll('\\', '/')
const codeStamp = fixtureServerCodeStamp()
const IDLE_SHUTDOWN_MS = Number(process.env.ORCA_FIXTURES_IDLE_MS) || 20 * 60 * 1000

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
      const browser = await chromium.launch({ headless: true, ...attempt.options })
      console.log(`[fixtures] browser: ${attempt.label}`)
      return browser
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

async function routeFixtureRequest(req, res, runner, stop) {
  if (req.url === '/__fixtures/health') {
    sendJson(res, 200, { ok: true, pid: process.pid, codeStamp })
  } else if (req.url === '/__fixtures/list') {
    sendJson(res, 200, { fixtures: await runner.listFixtures() })
  } else if (req.url === '/__fixtures/shot' && req.method === 'POST') {
    sendJson(res, 200, await handleShot(runner, await readJsonBody(req)))
  } else if (req.url === '/__fixtures/stop' && req.method === 'POST') {
    sendJson(res, 200, { ok: true })
    setImmediate(stop)
  } else {
    sendJson(res, 404, { error: `Unknown fixture endpoint ${req.url}` })
  }
}

// Why: with HMR off Vite never re-expands import.meta.glob, so a new or deleted
// fixture file must invalidate the registry module that owns the glob.
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
        routeFixtureRequest(req, res, session.runner, session.stop).catch((error) => {
          sendJson(res, 500, { error: String(error?.message ?? error) })
        })
      })
    }
  }
}

async function main() {
  await mkdir(fixtureCacheDir, { recursive: true })
  const port = await findFreePort()
  const baseUrl = `http://127.0.0.1:${port}`
  // Why parallel: browser launch and Vite startup are independent cold costs.
  const browserPromise = launchHeadlessBrowser()
  browserPromise.catch(() => {})
  const session = { runner: null, lastActivity: Date.now(), stop: () => {} }
  const vite = await createViteServer({
    configFile: 'config/vite.fixtures.config.ts',
    clearScreen: false,
    logLevel: 'warn',
    // Why no HMR: the runner reloads its page on change, so pushed updates would only race it.
    server: { port, strictPort: true, host: '127.0.0.1', open: false, hmr: false },
    plugins: [createFixtureApiPlugin(session)]
  })
  await vite.listen()
  await browserPromise

  let stopping = false
  const stop = async () => {
    if (stopping) {
      return
    }
    stopping = true
    clearInterval(idleTimer)
    await rm(serverStatePath, { force: true })
    await (await browserPromise.catch(() => null))?.close()
    await vite.close()
    process.exit(0)
  }
  const idleTimer = setInterval(() => {
    if (Date.now() - session.lastActivity > IDLE_SHUTDOWN_MS) {
      void stop()
    }
  }, 30_000)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => void stop())
  }
  session.stop = () => void stop()
  session.runner = createFixturePageRunner(baseUrl, browserPromise)

  await writeFile(
    serverStatePath,
    JSON.stringify({ pid: process.pid, port, url: baseUrl, codeStamp })
  )
  await rm(serverLockPath, { force: true })
  console.log(`[fixtures] ready at ${baseUrl}/fixtures.html`)
}

main().catch(async (error) => {
  console.error(`[fixtures] server failed: ${error?.stack ?? error}`)
  await rm(serverLockPath, { force: true })
  process.exit(1)
})
