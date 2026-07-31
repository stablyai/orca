import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const INTERNAL_ENV = 'ORCA_PACKAGED_WATCHDOG_SMOKE_INTERNAL'
const ASAR_ENV = 'ORCA_PACKAGED_WATCHDOG_SMOKE_ASAR'
const TIMEOUT_MS = 100
const CHECK_INTERVAL_MS = 20
const POLL_TIMEOUT_MS = 5_000
const SUCCESS_LINE = '[packaged-watchdog-smoke] app.asar worker detected and recovered a stall'

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function readAppDirArg(argv) {
  const explicit = argv.find((arg) => arg.startsWith('--app-dir='))
  if (explicit) {
    return explicit.slice('--app-dir='.length)
  }
  if (process.platform === 'darwin') {
    return 'dist/mac-arm64/Orca.app'
  }
  if (process.platform === 'win32') {
    return 'dist/win-unpacked'
  }
  return 'dist/linux-unpacked'
}

function getResourcesDir(appDir) {
  return process.platform === 'darwin' || appDir.endsWith('.app')
    ? join(appDir, 'Contents', 'Resources')
    : join(appDir, 'resources')
}

function readMarker(markerPath) {
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}

async function waitForMarker(markerPath, predicate, workerError) {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (workerError.current) {
      throw workerError.current
    }
    const marker = readMarker(markerPath)
    if (predicate(marker)) {
      return marker
    }
    await sleep(CHECK_INTERVAL_MS)
  }
  throw new Error(`Timed out waiting for packaged watchdog marker at ${markerPath}`)
}

async function waitForExit(worker, workerError) {
  const exitCode = await Promise.race([
    new Promise((resolveExit) => worker.once('exit', resolveExit)),
    sleep(POLL_TIMEOUT_MS).then(() => {
      throw new Error('Timed out waiting for packaged watchdog worker to exit')
    })
  ])
  if (workerError.current) {
    throw workerError.current
  }
  if (exitCode !== 0) {
    throw new Error(`Packaged watchdog worker exited with code ${exitCode}`)
  }
}

async function runInternal() {
  const appAsar = process.env[ASAR_ENV]
  if (!appAsar) {
    throw new Error(`Missing ${ASAR_ENV}`)
  }
  const { app } = await import('electron')
  const tempRoot = mkdtempSync(join(tmpdir(), 'orca-packaged-watchdog-smoke-'))
  const markerPath = join(tempRoot, 'main-thread-hang.json')
  const entryPath = join(appAsar, 'out', 'main', 'main-thread-hang-watchdog-entry.js')
  let worker
  try {
    await app.whenReady()
    if (!existsSync(entryPath)) {
      throw new Error(`Packaged watchdog entry is missing from app.asar: ${entryPath}`)
    }
    const workerError = { current: null }
    worker = new Worker(entryPath, {
      workerData: {
        parentPid: process.pid,
        markerPath,
        timeoutMs: TIMEOUT_MS,
        checkIntervalMs: CHECK_INTERVAL_MS
      }
    })
    worker.once('error', (error) => {
      workerError.current = error
    })
    await waitForMarker(markerPath, (marker) => marker?.selfRecovered === false, workerError)
    worker.postMessage({ type: 'heartbeat' })
    await waitForMarker(markerPath, (marker) => marker?.selfRecovered === true, workerError)
    worker.postMessage({ type: 'shutdown' })
    await waitForExit(worker, workerError)
    worker = undefined
    console.log(SUCCESS_LINE)
  } finally {
    await worker?.terminate()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function runSmoke() {
  const appDir = resolve(readAppDirArg(process.argv.slice(2)))
  const appAsar = join(getResourcesDir(appDir), 'app.asar')
  if (!existsSync(appAsar)) {
    throw new Error(`Packaged app archive is missing: ${appAsar}`)
  }
  const require = createRequire(import.meta.url)
  const executable = require('electron')
  const launcherDir = mkdtempSync(join(tmpdir(), 'orca-packaged-watchdog-launcher-'))
  const launcherPath = join(launcherDir, 'main.cjs')
  writeFileSync(
    join(launcherDir, 'package.json'),
    JSON.stringify({ name: 'orca-packaged-watchdog-smoke', main: 'main.cjs' })
  )
  writeFileSync(
    launcherPath,
    `import(${JSON.stringify(pathToFileURL(import.meta.filename).href)}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})\n`
  )
  const env = { ...process.env, [INTERNAL_ENV]: '1', [ASAR_ENV]: appAsar, NODE_PATH: '' }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const electronArgs =
      process.platform === 'linux' ? ['--no-sandbox', launcherDir] : [launcherDir]
    const result = spawnSync(executable, electronArgs, {
      env,
      encoding: 'utf8',
      timeout: 15_000
    })
    if (result.status !== 0) {
      throw new Error(
        `Packaged watchdog smoke failed (${result.error?.message ?? result.signal ?? result.status}):\n` +
          `${result.stderr || result.stdout}`
      )
    }
    // Why: Electron discards process.exitCode, so status 0 alone can't prove the worker ran.
    if (!result.stdout.includes(SUCCESS_LINE)) {
      throw new Error(
        `Packaged watchdog smoke did not report success:\n${result.stderr || result.stdout}`
      )
    }
    process.stdout.write(result.stdout)
  } finally {
    rmSync(launcherDir, { recursive: true, force: true })
  }
}

if (process.env[INTERNAL_ENV] === '1') {
  // Why: a graceful quit exits 0 regardless of process.exitCode; only app.exit propagates failure.
  const { app } = await import('electron')
  try {
    await runInternal()
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
} else {
  runSmoke()
}
