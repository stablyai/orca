import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const ENTRY_PATH = resolve('out/main/parcel-watcher-process-entry.js')
const POOL_SOURCE = resolve('src/main/ipc/runtime-watcher-process-pool.ts')
const FAILURE_SOURCE = resolve('src/main/ipc/parcel-watcher-process-failure.ts')
const REGISTRY_SOURCE = resolve('src/main/ipc/parcel-watcher-child-registry.ts')
const MAX_CHILD_RSS_KIB = 128 * 1024
const MAX_CHILD_CPU_PERCENT = 50
const MAX_QUARANTINE_RSS_KIB = 512 * 1024
const MAX_QUARANTINE_CPU_PERCENT = 100
const PHYSICAL_CHILD_CAP = 8
const WAIT_TIMEOUT_MS = 15_000
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

async function main() {
  if (!existsSync(ENTRY_PATH)) {
    throw new Error(`Missing ${ENTRY_PATH}; run pnpm run build:electron-vite first`)
  }

  const createdRoots = []
  const exactPids = new Set()
  let bundleDir
  let pool
  let result
  try {
    bundleDir = await mkdtemp(join(tmpdir(), 'orca-runtime-watcher-resource-'))
    const { RuntimeWatcherProcessPool, WatcherProcessFailure, reserveWatcherChild } =
      await loadProbe(bundleDir)
    const roots = []
    for (let index = 0; index < 5; index++) {
      const createdRoot = await mkdtemp(join(tmpdir(), `orca-watcher-resource-${index}-`))
      createdRoots.push(createdRoot)
      roots.push(await realpath(createdRoot))
    }

    pool = new RuntimeWatcherProcessPool()
    await Promise.all(roots.map((rootPath) => pool.subscribe(rootPath, () => undefined, {}, {})))
    const healthyPids = activeChildPids(pool)
    assertPidCount(healthyPids, 1, 'five healthy roots')
    healthyPids.forEach((pid) => exactPids.add(pid))
    const healthyResources = await sampleResources(healthyPids)
    assertResourceBudget(healthyResources, 'healthy pool', {
      maxTotalRssKiB: MAX_CHILD_RSS_KIB,
      maxTotalCpuPercent: MAX_CHILD_CPU_PERCENT
    })
    assertRegistryCapacity(reserveWatcherChild, 7)

    const sharedSlot = [...pool.activeSlots][0]
    const failure = new WatcherProcessFailure(
      'resource probe synthetic shared-shard fault',
      'supervisor',
      'supervisor_crash_fuse'
    )
    for (const record of sharedSlot.supervisor.records.values()) {
      record.hooks.onTerminalError?.(failure)
    }
    await waitFor(() => !isPidAlive(healthyPids[0]), 'healthy child exit')

    await Promise.all(
      roots.slice(0, 4).map((rootPath) => pool.subscribe(rootPath, () => undefined, {}, {}))
    )
    const quarantinePids = activeChildPids(pool)
    assertPidCount(quarantinePids, 4, 'four fault-quarantine roots')
    quarantinePids.forEach((pid) => exactPids.add(pid))
    const quarantineResources = await sampleResources(quarantinePids)
    assertResourceBudget(quarantineResources, 'quarantine pool', {
      maxTotalRssKiB: MAX_QUARANTINE_RSS_KIB,
      maxTotalCpuPercent: MAX_QUARANTINE_CPU_PERCENT
    })
    // Four live quarantine children leave four reservations before the global
    // eight-physical-child ceiling rejects the next launch.
    assertRegistryCapacity(reserveWatcherChild, 4)

    result = {
      hostPid: process.pid,
      healthy: summarizeResources(healthyResources),
      quarantine: summarizeResources(quarantineResources),
      physicalChildCap: PHYSICAL_CHILD_CAP,
      budgets: {
        maxChildRssKiB: MAX_CHILD_RSS_KIB,
        maxChildCpuPercent: MAX_CHILD_CPU_PERCENT,
        maxQuarantineRssKiB: MAX_QUARANTINE_RSS_KIB,
        maxQuarantineCpuPercent: MAX_QUARANTINE_CPU_PERCENT,
        maxPhysicalRssKiB: MAX_CHILD_RSS_KIB * PHYSICAL_CHILD_CAP,
        maxPhysicalCpuPercent: MAX_CHILD_CPU_PERCENT * PHYSICAL_CHILD_CAP
      },
      exactPidCleanup: true
    }
  } finally {
    pool?.dispose()
    await Promise.all(
      [...exactPids].map((pid) => waitFor(() => !isPidAlive(pid), `watcher PID ${pid} cleanup`))
    )
    await Promise.all([
      ...createdRoots.map((rootPath) => rm(rootPath, { recursive: true, force: true })),
      bundleDir ? rm(bundleDir, { recursive: true, force: true }) : Promise.resolve()
    ])
  }
  console.log(JSON.stringify(result))
}

async function loadProbe(bundleDir) {
  const outfile = join(bundleDir, 'watcher-resource-probe.cjs')
  await build({
    stdin: {
      contents: [
        `export { RuntimeWatcherProcessPool } from ${JSON.stringify(POOL_SOURCE)}`,
        `export { WatcherProcessFailure } from ${JSON.stringify(FAILURE_SOURCE)}`,
        `export { reserveWatcherChild } from ${JSON.stringify(REGISTRY_SOURCE)}`
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'runtime-file-watcher-resource-probe-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['@parcel/watcher', 'electron'],
    logLevel: 'silent'
  })
  return require(outfile)
}

function activeChildPids(pool) {
  return [...pool.activeSlots]
    .map((slot) => slot.supervisor.child?.pid)
    .filter((pid) => Number.isInteger(pid))
}

function assertPidCount(pids, expected, label) {
  if (new Set(pids).size !== expected || pids.some((pid) => !isPidAlive(pid))) {
    throw new Error(
      `${label} used ${new Set(pids).size} live watcher children; expected ${expected}`
    )
  }
}

function assertRegistryCapacity(reserveWatcherChild, availableReservations) {
  const releases = []
  try {
    for (let index = 0; index < availableReservations; index++) {
      const release = reserveWatcherChild()
      if (!release) {
        throw new Error(`Watcher child registry rejected reservation ${index + 1}`)
      }
      releases.push(release)
    }
    const unexpectedReservation = reserveWatcherChild()
    if (unexpectedReservation) {
      unexpectedReservation()
      throw new Error('Watcher child registry exceeded its global physical-process cap')
    }
  } finally {
    releases.forEach((release) => release())
  }
}

async function sampleResources(pids) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  return Promise.all(pids.map((pid) => sampleProcess(pid)))
}

async function sampleProcess(pid) {
  if (process.platform === 'win32') {
    const command =
      `$p=Get-Process -Id ${pid};` +
      `[pscustomobject]@{rssKiB=[math]::Round($p.WorkingSet64/1KB);cpuSeconds=$p.CPU}|ConvertTo-Json -Compress`
    const first = JSON.parse(
      (await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command])).stdout.trim()
    )
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    const second = JSON.parse(
      (await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command])).stdout.trim()
    )
    return {
      pid,
      rssKiB: second.rssKiB,
      cpuPercent: Math.max(0, (second.cpuSeconds - first.cpuSeconds) * 400)
    }
  }
  const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-o', '%cpu=', '-p', String(pid)], {
    env: { ...process.env, LC_ALL: 'C' }
  })
  const [rssKiB, cpuPercent] = stdout.trim().split(/\s+/).map(Number)
  return { pid, rssKiB, cpuPercent }
}

function assertResourceBudget(resources, label, { maxTotalRssKiB, maxTotalCpuPercent }) {
  for (const resource of resources) {
    if (!Number.isFinite(resource.rssKiB) || resource.rssKiB <= 0) {
      throw new Error(`Missing RSS evidence for watcher PID ${resource.pid}`)
    }
    if (resource.rssKiB > MAX_CHILD_RSS_KIB) {
      throw new Error(
        `Watcher PID ${resource.pid} RSS ${resource.rssKiB} KiB exceeded ${MAX_CHILD_RSS_KIB} KiB`
      )
    }
    if (!Number.isFinite(resource.cpuPercent) || resource.cpuPercent < 0) {
      throw new Error(`Missing CPU evidence for watcher PID ${resource.pid}`)
    }
    if (resource.cpuPercent > MAX_CHILD_CPU_PERCENT) {
      throw new Error(
        `Watcher PID ${resource.pid} CPU ${resource.cpuPercent}% exceeded ${MAX_CHILD_CPU_PERCENT}%`
      )
    }
  }
  const summary = summarizeResources(resources)
  if (summary.totalRssKiB > maxTotalRssKiB) {
    throw new Error(
      `${label} RSS ${summary.totalRssKiB} KiB exceeded aggregate budget ${maxTotalRssKiB} KiB`
    )
  }
  if (summary.sampledCpuPercent > maxTotalCpuPercent) {
    throw new Error(
      `${label} CPU ${summary.sampledCpuPercent}% exceeded aggregate budget ${maxTotalCpuPercent}%`
    )
  }
}

function summarizeResources(resources) {
  return {
    childCount: resources.length,
    pids: resources.map(({ pid }) => pid),
    totalRssKiB: resources.reduce((total, { rssKiB }) => total + rssKiB, 0),
    sampledCpuPercent: resources.reduce((total, { cpuPercent }) => total + cpuPercent, 0)
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
}

await main()
