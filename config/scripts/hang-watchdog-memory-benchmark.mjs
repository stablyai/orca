#!/usr/bin/env node
import { execFileSync, fork, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import {
  childRssBytes,
  median,
  physicalFootprintBytes,
  sampleMemory,
  sampleProductionPerformance
} from './hang-watchdog-process-metrics.mjs'

const INTERNAL_ENV = 'ORCA_HANG_WATCHDOG_BENCH_INTERNAL'
const BOUNDARY_ENV = 'ORCA_HANG_WATCHDOG_BENCH_BOUNDARY'
const RESULT_PREFIX = 'ORCA_HANG_WATCHDOG_BENCH_RESULT='
const DEFAULT_TRIALS = 7
const SETTLE_MS = 2_000
const SAMPLE_COUNT = 5
const SAMPLE_INTERVAL_MS = 200
const VERIFY_TIMEOUT_MS = 500
const VERIFY_CHECK_INTERVAL_MS = 50
const VERIFY_BLOCK_MS = 1_200
const PRODUCTION_HEARTBEAT_INTERVAL_MS = 2_000
const PRODUCTION_TIMEOUT_MS = 45_000
const PRODUCTION_CHECK_INTERVAL_MS = 5_000
const PRODUCTION_SAMPLE_MS = 30_000
const MAX_LAUNCH_ATTEMPTS = 3
const MIB = 1024 * 1024
const scriptPath = import.meta.filename
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const entryPath = path.join(repoRoot, 'out', 'main', 'main-thread-hang-watchdog-entry.js')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function forceGc() {
  if (typeof global.gc !== 'function') {
    throw new Error('Electron did not expose GC; keep --js-flags=--expose-gc in the harness')
  }
  global.gc()
  global.gc()
}

function blockMainThread(ms) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < ms) {
    // Intentional synchronous stall.
  }
  return { startedAt, endedAt: Date.now() }
}

function readMarker(markerPath) {
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}

async function verifyBlockedMainDetection(markerPath, sendHeartbeat) {
  const block = blockMainThread(VERIFY_BLOCK_MS)
  const detected = readMarker(markerPath)
  sendHeartbeat()
  const deadline = Date.now() + VERIFY_TIMEOUT_MS
  let resolved
  do {
    resolved = readMarker(markerPath)
    if (resolved?.selfRecovered === true) {
      break
    }
    await sleep(VERIFY_CHECK_INTERVAL_MS)
  } while (Date.now() < deadline)
  const verified =
    detected?.detectedAt >= block.startedAt &&
    detected.detectedAt <= block.endedAt &&
    detected.selfRecovered === false &&
    resolved?.selfRecovered === true
  if (!verified) {
    throw new Error(
      `Built watchdog failed blocked-main verification: ${JSON.stringify({ detected, resolved })}`
    )
  }
  return true
}

function startChild(markerPath, timeoutMs, checkIntervalMs) {
  const startedAt = process.hrtime.bigint()
  const child = fork(entryPath, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_HANG_WATCHDOG_PARENT_PID: String(process.pid),
      ORCA_HANG_WATCHDOG_MARKER_PATH: markerPath,
      ORCA_HANG_WATCHDOG_TIMEOUT_MS: String(timeoutMs),
      ORCA_HANG_WATCHDOG_CHECK_INTERVAL_MS: String(checkIntervalMs)
    }
  })
  const startupMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  return {
    pids: [process.pid, child.pid],
    startupMs,
    sendHeartbeat: () => child.send?.({ type: 'heartbeat' }),
    shutdown: async () => {
      if (child.exitCode !== null) {
        return
      }
      const exitPromise = new Promise((resolve) => child.once('exit', resolve))
      child.send?.({ type: 'shutdown' })
      if (child.connected) {
        child.disconnect()
      }
      await exitPromise
    }
  }
}

function startWorker(markerPath, timeoutMs, checkIntervalMs) {
  const startedAt = process.hrtime.bigint()
  const worker = new Worker(entryPath, {
    workerData: {
      parentPid: process.pid,
      markerPath,
      timeoutMs,
      checkIntervalMs
    }
  })
  const startupMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  return {
    pids: [process.pid],
    startupMs,
    sendHeartbeat: () => worker.postMessage({ type: 'heartbeat' }),
    shutdown: async () => {
      if (worker.threadId === -1) {
        return
      }
      const exitPromise = new Promise((resolve) => worker.once('exit', resolve))
      worker.postMessage({ type: 'shutdown' })
      await exitPromise
    }
  }
}

async function verifyBoundary(markerPath, startBoundary) {
  const boundary = startBoundary(markerPath, VERIFY_TIMEOUT_MS, VERIFY_CHECK_INTERVAL_MS)
  const heartbeat = setInterval(boundary.sendHeartbeat, 100)
  try {
    await sleep(SETTLE_MS)
    return await verifyBlockedMainDetection(markerPath, boundary.sendHeartbeat)
  } finally {
    clearInterval(heartbeat)
    await boundary.shutdown()
  }
}

async function measureChild(markerPath) {
  forceGc()
  await sleep(SETTLE_MS)
  forceGc()
  const before = await sampleMemory(
    () => process.memoryUsage().rss,
    () => physicalFootprintBytes([process.pid]),
    { sampleCount: SAMPLE_COUNT, sampleIntervalMs: SAMPLE_INTERVAL_MS, sleep }
  )
  const child = startChild(markerPath, PRODUCTION_TIMEOUT_MS, PRODUCTION_CHECK_INTERVAL_MS)
  let measurements
  try {
    await sleep(SETTLE_MS)
    forceGc()
    const childRss = await sampleMemory(
      () => childRssBytes(child.pids[1]),
      () => physicalFootprintBytes([child.pids[1]]),
      { sampleCount: SAMPLE_COUNT, sampleIntervalMs: SAMPLE_INTERVAL_MS, sleep }
    )
    const total = await sampleMemory(
      () => process.memoryUsage().rss + childRssBytes(child.pids[1]),
      () => physicalFootprintBytes(child.pids),
      { sampleCount: SAMPLE_COUNT, sampleIntervalMs: SAMPLE_INTERVAL_MS, sleep }
    )
    const performance = await sampleProductionPerformance(child, {
      heartbeatIntervalMs: PRODUCTION_HEARTBEAT_INTERVAL_MS,
      sampleMs: PRODUCTION_SAMPLE_MS,
      sleep
    })
    measurements = {
      rssBytes: childRss.rssBytes,
      summedProcessRssDeltaBytes: Math.max(0, total.rssBytes - before.rssBytes),
      physicalFootprintDeltaBytes: Math.max(
        0,
        total.physicalFootprintBytes - before.physicalFootprintBytes
      ),
      startupMs: child.startupMs,
      ...performance
    }
  } finally {
    await child.shutdown()
  }
  rmSync(markerPath, { force: true })
  return {
    ...measurements,
    blockedMainThreadVerified: await verifyBoundary(markerPath, startChild)
  }
}

async function measureWorker(markerPath) {
  forceGc()
  await sleep(SETTLE_MS)
  forceGc()
  const before = await sampleMemory(
    () => process.memoryUsage().rss,
    () => physicalFootprintBytes([process.pid]),
    { sampleCount: SAMPLE_COUNT, sampleIntervalMs: SAMPLE_INTERVAL_MS, sleep }
  )
  const worker = startWorker(markerPath, PRODUCTION_TIMEOUT_MS, PRODUCTION_CHECK_INTERVAL_MS)
  let measurements
  try {
    await sleep(SETTLE_MS)
    forceGc()
    const after = await sampleMemory(
      () => process.memoryUsage().rss,
      () => physicalFootprintBytes([process.pid]),
      { sampleCount: SAMPLE_COUNT, sampleIntervalMs: SAMPLE_INTERVAL_MS, sleep }
    )
    const performance = await sampleProductionPerformance(worker, {
      heartbeatIntervalMs: PRODUCTION_HEARTBEAT_INTERVAL_MS,
      sampleMs: PRODUCTION_SAMPLE_MS,
      sleep
    })
    const rssBytes = Math.max(0, after.rssBytes - before.rssBytes)
    measurements = {
      rssBytes,
      summedProcessRssDeltaBytes: rssBytes,
      physicalFootprintDeltaBytes: Math.max(
        0,
        after.physicalFootprintBytes - before.physicalFootprintBytes
      ),
      startupMs: worker.startupMs,
      ...performance
    }
  } finally {
    await worker.shutdown()
  }
  rmSync(markerPath, { force: true })
  return {
    ...measurements,
    blockedMainThreadVerified: await verifyBoundary(markerPath, startWorker)
  }
}

async function runInternal() {
  if (process.platform !== 'darwin') {
    throw new Error('The production watchdog is macOS-only; run this benchmark on macOS')
  }
  const { app } = await import('electron')
  const boundary = process.env[BOUNDARY_ENV]
  const profileDir = mkdtempSync(path.join(tmpdir(), 'orca-watchdog-bench-'))
  app.setPath('userData', profileDir)
  try {
    await app.whenReady()
    const markerPath = path.join(profileDir, 'main-thread-hang.json')
    const result =
      boundary === 'child'
        ? await measureChild(markerPath)
        : boundary === 'worker'
          ? await measureWorker(markerPath)
          : (() => {
              throw new Error(`Unsupported boundary: ${boundary}`)
            })()
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
  } finally {
    app.quit()
    rmSync(profileDir, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const options = { boundary: '', trials: DEFAULT_TRIALS, output: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--boundary' || arg === '--trials' || arg === '--output') {
      if (!value) {
        throw new Error(`Missing value for ${arg}`)
      }
      options[arg.slice(2)] = arg === '--trials' ? Number(value) : value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!['child', 'worker'].includes(options.boundary)) {
    throw new Error('--boundary must be child or worker')
  }
  if (!Number.isInteger(options.trials) || options.trials < 1) {
    throw new Error('--trials must be a positive integer')
  }
  return options
}

function electronPath() {
  const requirePath = import.meta.resolve('electron')
  const electronModulePath = fileURLToPath(requirePath)
  return execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(require(${JSON.stringify(electronModulePath)}))`],
    {
      encoding: 'utf8'
    }
  )
}

function runTrial(executable, boundary) {
  for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt += 1) {
    const env = { ...process.env, [INTERNAL_ENV]: '1', [BOUNDARY_ENV]: boundary }
    delete env.ELECTRON_RUN_AS_NODE
    const launcherDir = mkdtempSync(path.join(tmpdir(), 'orca-watchdog-bench-launcher-'))
    writeFileSync(
      path.join(launcherDir, 'package.json'),
      JSON.stringify({ name: 'orca-watchdog-benchmark', main: 'main.cjs' })
    )
    writeFileSync(
      path.join(launcherDir, 'main.cjs'),
      `import(${JSON.stringify(pathToFileURL(scriptPath).href)}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})\n`
    )
    let result
    try {
      result = spawnSync(executable, ['--js-flags=--expose-gc', launcherDir], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 90_000
      })
    } finally {
      rmSync(launcherDir, { recursive: true, force: true })
    }
    if (result.status !== 0) {
      throw new Error(
        `Electron trial failed (${result.error?.message ?? result.signal ?? result.status}):\n` +
          `${result.stderr || result.stdout}`
      )
    }
    const line = result.stdout.split('\n').find((candidate) => candidate.startsWith(RESULT_PREFIX))
    if (line) {
      return { ...JSON.parse(line.slice(RESULT_PREFIX.length)), launchAttempts: attempt }
    }
    if (attempt === MAX_LAUNCH_ATTEMPTS || result.stderr || result.stdout) {
      throw new Error(`Electron trial did not report a result (status ${result.status})`)
    }
  }
  throw new Error('Electron trial exhausted launcher attempts')
}

function runBenchmark() {
  if (process.platform !== 'darwin') {
    throw new Error('The production watchdog is macOS-only; run this benchmark on macOS')
  }
  if (!existsSync(entryPath)) {
    throw new Error(`Missing ${entryPath}; run pnpm exec electron-vite build first`)
  }
  const options = parseArgs(process.argv.slice(2))
  const builtEntry = readFileSync(entryPath, 'utf8')
  const hasChildContract = builtEntry.includes('ORCA_HANG_WATCHDOG_PARENT_PID')
  const hasWorkerContract = builtEntry.includes('workerData') && builtEntry.includes('parentPort')
  if (
    (options.boundary === 'child' && !hasChildContract) ||
    (options.boundary === 'worker' && !hasWorkerContract)
  ) {
    throw new Error(
      `Built watchdog does not implement the requested ${options.boundary} boundary; rebuild the matching revision`
    )
  }
  const executable = electronPath()
  const results = Array.from({ length: options.trials }, () =>
    runTrial(executable, options.boundary)
  )
  const rssBytes = results.map((result) => result.rssBytes)
  const summedProcessRssDeltaBytes = results.map((result) => result.summedProcessRssDeltaBytes)
  const physicalFootprintDeltaBytes = results.map((result) => result.physicalFootprintDeltaBytes)
  const startupMs = results.map((result) => result.startupMs)
  const cpuMs = results.map((result) => result.cpuMs)
  const eventLoopDelayP95Ms = results.map((result) => result.eventLoopDelayP95Ms)
  const eventLoopDelayP99Ms = results.map((result) => result.eventLoopDelayP99Ms)
  const eventLoopDelayMaxMs = results.map((result) => result.eventLoopDelayMaxMs)
  const report = {
    benchmark: 'hang-watchdog-memory',
    boundary: options.boundary,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8'
    }).trim(),
    electron: execFileSync(executable, ['-e', 'process.stdout.write(process.versions.electron)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8'
    }).trim(),
    settleMs: SETTLE_MS,
    samplesPerTrial: SAMPLE_COUNT,
    productionHeartbeatIntervalMs: PRODUCTION_HEARTBEAT_INTERVAL_MS,
    productionCheckIntervalMs: PRODUCTION_CHECK_INTERVAL_MS,
    productionSampleMs: PRODUCTION_SAMPLE_MS,
    trials: options.trials,
    rssMiB: rssBytes.map((value) => Number((value / MIB).toFixed(2))),
    medianRssMiB: Number((median(rssBytes) / MIB).toFixed(2)),
    summedProcessRssDeltaMiB: summedProcessRssDeltaBytes.map((value) =>
      Number((value / MIB).toFixed(2))
    ),
    medianSummedProcessRssDeltaMiB: Number((median(summedProcessRssDeltaBytes) / MIB).toFixed(2)),
    physicalFootprintDeltaMiB: physicalFootprintDeltaBytes.map((value) =>
      Number((value / MIB).toFixed(2))
    ),
    medianPhysicalFootprintDeltaMiB: Number((median(physicalFootprintDeltaBytes) / MIB).toFixed(2)),
    startupMs: startupMs.map((value) => Number(value.toFixed(3))),
    medianStartupMs: Number(median(startupMs).toFixed(3)),
    cpuMs: cpuMs.map((value) => Number(value.toFixed(2))),
    medianCpuMs: Number(median(cpuMs).toFixed(2)),
    eventLoopDelayP95Ms: eventLoopDelayP95Ms.map((value) => Number(value.toFixed(3))),
    medianEventLoopDelayP95Ms: Number(median(eventLoopDelayP95Ms).toFixed(3)),
    eventLoopDelayP99Ms: eventLoopDelayP99Ms.map((value) => Number(value.toFixed(3))),
    medianEventLoopDelayP99Ms: Number(median(eventLoopDelayP99Ms).toFixed(3)),
    eventLoopDelayMaxMs: eventLoopDelayMaxMs.map((value) => Number(value.toFixed(3))),
    medianEventLoopDelayMaxMs: Number(median(eventLoopDelayMaxMs).toFixed(3)),
    heartbeatCounts: results.map((result) => result.heartbeatCount),
    launchAttempts: results.map((result) => result.launchAttempts),
    blockedMainThreadVerified: results.every((result) => result.blockedMainThreadVerified)
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(serialized)
  if (options.output) {
    writeFileSync(path.resolve(options.output), serialized)
  }
}

if (process.env[INTERNAL_ENV] === '1') {
  await runInternal()
} else {
  runBenchmark()
}
