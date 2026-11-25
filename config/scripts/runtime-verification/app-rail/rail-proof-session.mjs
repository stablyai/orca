// Shared setup for the app-rail runtime proofs: a fixture server, a driver browser, and teardown of whatever this
// invocation started. A fixture server that was already running (shared with fixtures-shot or the fixtures MCP) is
// reused and left running; one this invocation started is stopped before it exits, on success, on an assertion
// failure, on a driver-launch failure, and on SIGINT/SIGTERM.
//
// Env:
//   ORCA_RAIL_PROOF_BROWSER  executable for the driver browser (default: Playwright's headless shell). A path that
//                            does not exist exercises the launch-failure teardown.
//   ORCA_RAIL_PROOF_FAIL     `assert` throws an assertion failure once the session is up, to exercise that teardown.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import {
  callFixtureServer,
  ensureFixtureServer
} from '../../component-fixtures/fixture-server-client.mjs'
import { repoRoot, serverStatePath } from '../../component-fixtures/fixture-paths.mjs'

const PLAYWRIGHT_VERSION = JSON.parse(
  readFileSync(path.join(repoRoot, 'node_modules/playwright-core/package.json'), 'utf8')
).version

function log(line) {
  console.log(`[rail-proof] ${line}`)
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true
    }
    await delay(100)
  }
  return !isAlive(pid)
}

function readServerState() {
  try {
    return JSON.parse(readFileSync(serverStatePath, 'utf8'))
  } catch {
    return null
  }
}

// The fixture server's own processes (its headless Chromium); empty where pgrep is unavailable.
function childPids(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

/** Stops a process: SIGTERM, then SIGKILL, waiting for each; true once it is gone. */
async function terminate(pid, graceMs) {
  if (await waitForExit(pid, graceMs)) {
    return true
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(pid, signal)
    } catch {
      return true
    }
    if (await waitForExit(pid, 10_000)) {
      return true
    }
  }
  return !isAlive(pid)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Starts (or reuses) the fixture server and launches the driver browser, then runs `body`. Always tears down what it
 * started and sets the exit status: 0 when `body` resolves, 1 otherwise.
 */
export async function runRailProof(name, body) {
  const owned = { server: null, driver: null, browser: null }
  // Set when this run asked for a server start, so a start that fails or times out is still cleaned up.
  let startRequested = false
  const preexistingPid = readServerState()?.pid ?? null
  let tornDown = false
  const teardown = async () => {
    if (tornDown) {
      return
    }
    tornDown = true
    if (owned.browser) {
      await owned.browser.close().catch(() => {})
    }
    if (owned.driver) {
      const pid = owned.driver.process()?.pid
      await owned.driver.close().catch(() => {})
      const gone = pid ? await terminate(pid, 5000) : true
      log(`teardown: driver browser pid ${pid} ${gone ? 'exited' : 'STILL RUNNING'}`)
    }
    if (!owned.server && startRequested) {
      const state = readServerState()
      if (state?.pid && state.pid !== preexistingPid && isAlive(state.pid)) {
        owned.server = { pid: state.pid, url: state.url, children: childPids(state.pid) }
      }
    }
    if (owned.server) {
      const { pid, url, children } = owned.server
      await callFixtureServer(url, 'stop', {}).catch(() => {})
      // The server stops its own browser on stop; an unresponsive one is signalled so nothing outlives this run.
      const serverGone = await terminate(pid, 10_000)
      const childrenGone = await Promise.all(children.map((child) => terminate(child, 5000)))
      log(
        `teardown: fixture server children [${children.join(', ')}] ${childrenGone.every(Boolean) ? 'exited' : 'STILL RUNNING'}`
      )
      log(
        `teardown: fixture server pid ${String(pid)} (started by this run) ${serverGone ? 'stopped' : 'STILL RUNNING'}`
      )
    }
  }
  const onSignal = (signal) => {
    log(`received ${signal}; tearing down`)
    void teardown().finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  log(`${name}: node pid ${process.pid}, playwright-core ${PLAYWRIGHT_VERSION}`)
  try {
    const { url, started } = await ensureFixtureServer({
      onStart: () => {
        startRequested = true
      }
    })
    const state = readServerState()
    const children = childPids(state.pid)
    if (started) {
      owned.server = { pid: state.pid, url, children }
    }
    log(
      `fixture server pid ${state.pid} (children [${children.join(', ')}]) at ${url} (${started ? 'started by this run; will stop it' : 'preexisting; left running'})`
    )
    const executablePath = process.env.ORCA_RAIL_PROOF_BROWSER || undefined
    owned.driver = await chromium.launchServer({ headless: true, executablePath })
    owned.browser = await chromium.connect(owned.driver.wsEndpoint())
    log(
      `driver browser pid ${owned.driver.process()?.pid}, ${executablePath ?? 'playwright chromium-headless-shell'} ${owned.browser.version()}`
    )
    if (process.env.ORCA_RAIL_PROOF_FAIL === 'assert') {
      throw new Error('forced assertion failure (ORCA_RAIL_PROOF_FAIL=assert)')
    }
    const page = await owned.browser.newPage({ viewport: { width: 800, height: 600 } })
    page.setDefaultTimeout(120_000)
    page.on('pageerror', (error) => console.error(`[page error] ${error.message}`))
    await body({ page, url, served: (paths) => servedSources(url, paths) })
    log(`${name}: PASS`)
    process.exitCode = 0
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    log(`${name}: FAIL`)
    process.exitCode = 1
  } finally {
    await teardown()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    log(`exit status ${process.exitCode}`)
  }
}

// A loaded host can drop a connection while Vite transforms; a few retries tell that apart from a dead server.
async function fetchWithRetry(target) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(target, { signal: AbortSignal.timeout(60_000) })
    } catch (error) {
      if (attempt === 4) {
        throw error
      }
      await delay(2000 * attempt)
    }
  }
}

/**
 * What the fixture server actually serves for these sources, so a result is bound to the code under test rather than
 * to a checkout: the hash of each on-disk file and of the module the server transforms from it, plus marker checks.
 */
async function servedSources(url, paths) {
  const lines = []
  const modules = {}
  for (const relativePath of paths) {
    const disk = readFileSync(path.join(repoRoot, 'src/renderer', relativePath), 'utf8')
    const response = await fetchWithRetry(`${url}/${relativePath}`)
    const served = await response.text()
    if (!response.ok) {
      throw new Error(`fixture server could not serve ${relativePath}: ${response.status}`)
    }
    modules[relativePath] = served
    lines.push(
      `${relativePath}: disk sha256 ${sha256(disk).slice(0, 16)}, served sha256 ${sha256(served).slice(0, 16)} (${served.length} bytes)`
    )
  }
  return { lines, modules }
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
  await page.goto(`${url}/fixtures.html?id=app-rail/AppRail:${name}&theme=${theme}`)
  await page.waitForFunction(() =>
    ['ready', 'error'].includes(document.documentElement.dataset.fixtureState ?? '')
  )
  const state = await page.getAttribute('html', 'data-fixture-state')
  if (state !== 'ready') {
    throw new Error(`fixture ${name} (${theme}) did not render: ${state}`)
  }
  await paint(page)
}
