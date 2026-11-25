// Session for the app-rail runtime proofs. Each invocation owns everything it uses: its own in-process Vite server for
// the component fixtures (its own port and dependency cache) and a driver browser it launches. It never contacts,
// adopts, stops or signals the shared fixture server that fixtures-shot and the fixtures MCP use.
//
// Teardown is one promise, shared by the normal path and signal handlers. It waits for acquisitions still in flight,
// closes each resource with a deadline, escalates only through live handles (the driver's own process group while its
// leader is unreaped, children this process spawned), takes an inventory of what is left, and fails the run if anything
// is unresolved, including an inventory that could not be taken. The exit has one owner: once a signal arrives, the
// signal path decides; otherwise the normal path does. Later signals only wait for the same teardown.
//
// Unix only (process groups and pgrep), like the rest of the fixture tooling's process handling.
//
// Env (test hooks for the teardown checks; unset in ordinary runs):
//   ORCA_RAIL_PROOF_BROWSER   driver executable (default: Playwright's headless shell); a missing path fails the launch.
//   ORCA_RAIL_PROOF_FAIL      `assert`: fail once the session is up.
//   ORCA_RAIL_PROOF_HOLD      `server` | `driver` (while that acquisition is in flight), `body`, `teardown`: print
//                             "holding at <stage>" and wait there until a signal arrives.
//   ORCA_RAIL_PROOF_SACRIFICE `1`: also start an owned process group (a parent and a child, both ignoring SIGTERM),
//                             so teardown must escalate to SIGKILL and account for a descendant.
//   ORCA_RAIL_PROOF_HANG      `vite-close`: Vite's close never settles, to show the deadline and the failing status.
//   ORCA_RAIL_PROOF_PGREP     inventory command (default: pgrep); a missing one shows an inventory failure fails the run.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { createServer as createViteServer } from 'vite'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const SIGNAL_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
const ACQUIRE_SETTLE_MS = 180_000
const CLOSE_MS = 10_000
const KILL_WAIT_MS = 10_000

function log(line) {
  console.log(`[rail-proof] ${line}`)
}

// Why: writes to a piped stdout are asynchronous, so exiting at once can drop the last log lines.
function exitAfterFlush(code) {
  process.exitCode = code
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

async function sha256File(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** The promise's outcome, or `'timed out'` once `ms` pass; never rejects. */
function settleWithin(promise, ms) {
  return Promise.race([
    promise.then(
      () => 'done',
      (error) => `failed: ${String(error?.message ?? error).split('\n')[0]}`
    ),
    delay(ms).then(() => 'timed out')
  ])
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/** Waits for a child this process spawned (a live handle, so its pid cannot be reused while unreaped). */
function waitForChildExit(child, ms) {
  if (hasExited(child)) {
    return Promise.resolve(true)
  }
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(ms).then(() => hasExited(child))
  ])
}

/** Pids from pgrep; throws when the inventory itself fails, so a failure never reads as "none left". */
function pgrep(args, what) {
  return new Promise((resolve, reject) => {
    execFile(process.env.ORCA_RAIL_PROOF_PGREP || 'pgrep', args, (error, stdout) => {
      if (!error || error.code === 1) {
        resolve(String(stdout).split('\n').filter(Boolean).map(Number))
      } else {
        reject(new Error(`inventory of ${what} failed: ${error.message}`))
      }
    })
  })
}

/**
 * Signals an owned process group and waits until it is empty. Only called while the group's leader is a live child
 * handle of this process or the group still has members, so the group id cannot belong to anyone else.
 */
async function stopProcessGroup(label, pgid, leader) {
  const steps = []
  try {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const members = await pgrep(['-g', String(pgid)], `process group ${pgid}`)
      if (members.length === 0 && hasExited(leader)) {
        break
      }
      try {
        process.kill(-pgid, signal)
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error
        }
      }
      steps.push(`${signal} to [${members.join(', ')}]`)
      const deadline = Date.now() + KILL_WAIT_MS
      while (Date.now() < deadline) {
        await delay(200)
        if ((await pgrep(['-g', String(pgid)], `process group ${pgid}`)).length === 0) {
          break
        }
      }
    }
    const left = await pgrep(['-g', String(pgid)], `process group ${pgid}`)
    const after = steps.length ? ` after ${steps.join(', ')}` : ''
    log(
      `teardown: ${label} group ${pgid}: ${left.length ? `STILL RUNNING [${left.join(', ')}]` : 'empty'}${after}`
    )
    return left.length === 0
  } catch (error) {
    log(`teardown: ${label} group ${pgid}: ${error.message}`)
    return false
  }
}

// A parent and a child in their own process group, both ignoring SIGTERM: escalation and descendants must be handled.
function sacrificialGroup() {
  const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  const script = `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
  return spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' })
}

/**
 * Runs `body({ page, url, served })` against this invocation's own fixture server and driver browser, tears both down,
 * and exits: 0 when the body passed and teardown was complete, 1 when either failed, 128 + n after a signal.
 */
export async function runRailProof(name, body) {
  process.chdir(repoRoot)
  const owned = { vite: null, cacheDir: null, driver: null, browser: null, sacrifice: null }
  const inFlight = new Set()
  let signalName = null
  let releaseHolds = () => {}
  const cancelled = new Promise((resolve) => {
    releaseHolds = resolve
  })
  const holdAt = async (stage) => {
    if (process.env.ORCA_RAIL_PROOF_HOLD === stage) {
      log(`holding at ${stage}`)
      await cancelled
    }
  }
  const fence = () => {
    if (signalName) {
      throw new Error(`cancelled by ${signalName}`)
    }
  }
  const acquire = (promise) => {
    inFlight.add(promise)
    promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise)
    )
    return promise
  }

  const runTeardown = async () => {
    let complete = true
    if (inFlight.size > 0) {
      const pending = inFlight.size
      const outcome = await settleWithin(Promise.allSettled(inFlight), ACQUIRE_SETTLE_MS)
      log(`teardown: waited for ${pending} in-flight acquisition(s): ${outcome}`)
      complete &&= outcome === 'done'
    }
    await holdAt('teardown')
    if (owned.browser) {
      log(
        `teardown: driver connection close: ${await settleWithin(owned.browser.close(), CLOSE_MS)}`
      )
    }
    if (owned.driver) {
      const leader = owned.driver.process()
      const pgid = leader.pid
      log(`teardown: driver close: ${await settleWithin(owned.driver.close(), CLOSE_MS)}`)
      if (!hasExited(leader)) {
        log(`teardown: driver kill: ${await settleWithin(owned.driver.kill(), CLOSE_MS)}`)
      }
      const leaderGone = await waitForChildExit(leader, KILL_WAIT_MS)
      // Helpers can outlive the leader; the group id stays ours while any of them remain.
      const groupEmpty = await stopProcessGroup('driver browser', pgid, leader)
      complete &&= leaderGone && groupEmpty
      log(`teardown: driver browser pid ${pgid} ${leaderGone ? 'exited' : 'STILL RUNNING'}`)
    }
    if (owned.sacrifice) {
      complete &&= await stopProcessGroup('sacrificial', owned.sacrifice.pid, owned.sacrifice)
    }
    if (owned.vite) {
      const closing =
        process.env.ORCA_RAIL_PROOF_HANG === 'vite-close'
          ? new Promise(() => {})
          : owned.vite.close()
      const outcome = await settleWithin(closing, CLOSE_MS)
      log(`teardown: fixture server (in this process) close: ${outcome}`)
      complete &&= outcome === 'done'
    }
    if (owned.cacheDir) {
      await rm(owned.cacheDir, { recursive: true, force: true }).catch(() => {})
    }
    // Anything else this process spawned (none expected) is reported and fails the run, never guessed at.
    try {
      const own = await pgrep(['-P', String(process.pid)], "this process's children")
      log(`teardown: other children of this process still running: [${own.join(', ')}]`)
      complete &&= own.length === 0
    } catch (error) {
      log(`teardown: ${error.message}`)
      complete = false
    }
    log(`teardown: ${complete ? 'complete' : 'INCOMPLETE'}`)
    return complete
  }
  let teardownPromise = null
  const teardown = () => {
    teardownPromise ??= runTeardown()
    return teardownPromise
  }

  // One owner for the exit: the first signal takes it; the normal path exits only if no signal ever arrived.
  const onSignal = (signal) => {
    if (signalName) {
      log(`received ${signal} again; still tearing down`)
      return
    }
    signalName = signal
    log(`received ${signal}; tearing down`)
    releaseHolds()
    void teardown().then((complete) => {
      log(`exit status ${complete ? SIGNAL_CODES[signal] : 1}`)
      exitAfterFlush(complete ? SIGNAL_CODES[signal] : 1)
    })
  }
  for (const signal of Object.keys(SIGNAL_CODES)) {
    process.on(signal, onSignal)
  }

  const versionOf = async (pkg) =>
    JSON.parse(await readFile(path.join(repoRoot, 'node_modules', pkg, 'package.json'), 'utf8'))
      .version
  log(
    `${name}: node pid ${process.pid}, playwright-core ${await versionOf('playwright-core')}, vite ${await versionOf('vite')}, session sha256 ${(await sha256File(import.meta.filename)).slice(0, 16)}, proof sha256 ${(await sha256File(process.argv[1])).slice(0, 16)}`
  )
  let passed = false
  try {
    if (process.env.ORCA_RAIL_PROOF_SACRIFICE === '1') {
      owned.sacrifice = sacrificialGroup()
      log(`sacrificial process group ${owned.sacrifice.pid} (ignores SIGTERM, has a child)`)
    }
    owned.cacheDir = await mkdtemp(path.join(os.tmpdir(), 'orca-rail-proof-vite-'))
    const starting = acquire(
      (async () => {
        const vite = await createViteServer({
          configFile: path.join(repoRoot, 'config/vite.fixtures.config.ts'),
          cacheDir: owned.cacheDir,
          clearScreen: false,
          logLevel: 'warn',
          server: { host: '127.0.0.1', port: 0, open: false, hmr: false }
        })
        owned.vite = vite
        await vite.listen()
      })()
    )
    await Promise.all([starting, holdAt('server')])
    fence()
    const address = owned.vite.httpServer?.address()
    if (!address || typeof address === 'string') {
      throw new Error('the fixture server has no TCP address')
    }
    const url = `http://127.0.0.1:${address.port}`
    log(`fixture server: in this process at ${url}, dependency cache ${owned.cacheDir}`)

    const executablePath = process.env.ORCA_RAIL_PROOF_BROWSER || undefined
    const launching = acquire(
      (async () => {
        // Why: Playwright's own signal handlers would exit the process before this teardown runs.
        owned.driver = await chromium.launchServer({
          headless: true,
          executablePath,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false
        })
        owned.browser = await chromium.connect(owned.driver.wsEndpoint())
      })()
    )
    await Promise.all([launching, holdAt('driver')])
    fence()
    log(
      `driver browser pid ${owned.driver.process().pid} (its own process group), ${executablePath ?? 'playwright chromium-headless-shell'} ${owned.browser.version()}`
    )
    if (process.env.ORCA_RAIL_PROOF_FAIL === 'assert') {
      throw new Error('forced assertion failure (ORCA_RAIL_PROOF_FAIL=assert)')
    }
    await holdAt('body')
    fence()
    const page = await owned.browser.newPage({ viewport: { width: 800, height: 600 } })
    page.setDefaultTimeout(120_000)
    page.on('pageerror', (error) => console.error(`[page error] ${error.message}`))
    await body({ page, url, served: (paths) => servedSources(url, paths) })
    passed = true
    log(`${name}: PASS`)
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
    log(`${name}: FAIL`)
  }
  const complete = await teardown()
  if (signalName) {
    // The signal path owns the exit.
    return
  }
  const code = passed && complete ? 0 : 1
  log(`exit status ${code}`)
  exitAfterFlush(code)
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
      `${relativePath}: disk sha256 ${sha256(disk).slice(0, 16)}, served sha256 ${sha256(served).slice(0, 16)} (${served.length} bytes)`
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
