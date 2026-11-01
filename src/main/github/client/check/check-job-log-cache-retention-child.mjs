import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { workload } from '../../../../../config/scripts/check-job-log-performance-cases.mjs'

assert(
  !process.versions.bun && typeof globalThis.gc === 'function',
  'Node with explicit GC is required'
)
const [bundlePath, trial, manifest] = process.argv.slice(2)
const { identityHash, cpuDescriptors } = JSON.parse(manifest)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const host = await import(pathToFileURL(bundlePath).href)
const limit = 16 * 1024
const mib = 1024 * 1024
const repo = { owner: 'fixture', repo: 'host' }
const controller = new AbortController()
const options = { cwd: process.cwd(), host: 'github.com', signal: controller.signal, env: {} }
const context = {
  executionScope: 'measurement-fixture-scope',
  deadlineAt: Date.now() + 18_000,
  retainUntil: () => {}
}
const job = (id) => ({
  id,
  name: `fixture ${id}`,
  status: 'completed',
  conclusion: 'failure',
  startedAt: 'start',
  completedAt: 'done',
  url: null,
  logTail: null,
  steps: []
})
function memory() {
  void /reset/.test('reset')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage()
}
const delta = (before, after) =>
  Object.fromEntries(
    ['heapUsed', 'external', 'arrayBuffers', 'rss'].map((key) => [key, after[key] - before[key]])
  )
function parent(bytes, id) {
  const prefix = `${id}:`
  const suffix = 'ending-fixture'
  return [
    prefix,
    String.fromCharCode(65 + (id % 26)).repeat(bytes - prefix.length - suffix.length),
    suffix
  ].join('')
}
async function cold(id, bytes) {
  let raw = parent(bytes, id)
  host.setFixtureOutput(raw)
  const jobs = [job(id)]
  await host.attachFailedJobLogTails(jobs, repo, options, context)
  assert(jobs[0].logState === 'available' && Buffer.byteLength(jobs[0].logTail) <= limit)
  raw = ''
  host.setFixtureOutput('')
}
function cacheBytes() {
  return [...host.prCheckLogTailCache.values()].reduce(
    (total, entry) => total + Buffer.byteLength(entry.logTail ?? ''),
    0
  )
}
function cacheJsonBytes() {
  return Buffer.byteLength(JSON.stringify([...host.prCheckLogTailCache.values()]))
}
async function retained(count, bytes, offset) {
  host.prCheckLogTailCache.clear()
  const before = memory()
  for (let index = 0; index < count; index++) {
    await cold(offset + index, bytes)
  }
  const after = memory()
  const entries = host.prCheckLogTailCache.size
  const encodedBytes = cacheBytes()
  const jsonBytes = cacheJsonBytes()
  host.prCheckLogTailCache.clear()
  const released = memory()
  return {
    count,
    rawBytesPerLog: bytes,
    entries,
    encodedBytes,
    jsonBytes,
    retainedDelta: delta(before, after),
    releasedDelta: delta(before, released)
  }
}
for (let id = 0; id < 3; id++) {
  await cold(id + 1, 128 * 1024)
}
host.prCheckLogTailCache.clear()
const pinnedBefore = memory()
let pinned = Array.from({ length: 8 }, (_, index) => parent(8 * mib, index).slice(-limit))
const pinnedAfter = memory()
assert(pinned.every((value) => value.length === limit))
const pinnedControl = {
  count: pinned.length,
  encodedBytes: pinned.length * limit,
  retainedDelta: delta(pinnedBefore, pinnedAfter)
}
pinned = []
memory()
const eight = await retained(8, 8 * mib, 100)
assert(
  pinnedControl.retainedDelta.heapUsed > eight.retainedDelta.heapUsed * 8,
  'Host cache resembles the deliberately pinned raw-parent control'
)
const nearCap = await retained(3, 63 * mib, 200)
const maximum = await retained(129, 8 * mib, 300)
assert(nearCap.retainedDelta.heapUsed < pinnedControl.retainedDelta.heapUsed / 4)
assert(maximum.retainedDelta.heapUsed < pinnedControl.retainedDelta.heapUsed / 4)
assert.equal(maximum.entries, 128)
assert.equal(maximum.encodedBytes, 128 * limit)
for (let id = 1; id <= 5; id++) {
  await cold(id, 8 * mib)
}
const fullJobs = Array.from({ length: 5 }, (_, index) => job(index + 1))
const beforeWarm = host.downloadCount()
await host.attachFailedJobLogTails(fullJobs, repo, options, context)
assert.equal(host.downloadCount(), beforeWarm)
const fullPayload = {
  textBytes: fullJobs.reduce((sum, item) => sum + Buffer.byteLength(item.logTail ?? ''), 0),
  jsonBytes: Buffer.byteLength(JSON.stringify({ jobs: fullJobs }))
}
assert.equal(fullPayload.textBytes, 80 * 1024)
const mixed = [job(1), job(900), job(901), job(902), job(2), job(903)]
host.setFixtureOutput('', true)
const savedWarn = console.warn
console.warn = () => {}
await host.attachFailedJobLogTails([mixed[1]], repo, options, context)
host.setFixtureOutput('\x1b[31m\x00\x1b[0m')
await host.attachFailedJobLogTails([mixed[2]], repo, options, context)
host.setFixtureOutput(' \t\n')
await host.attachFailedJobLogTails([mixed[3]], repo, options, context)
host.setFixtureOutput('', true)
try {
  await host.attachFailedJobLogTails(mixed, repo, options, context)
} finally {
  console.warn = savedWarn
}
host.setFixtureOutput('')
assert.deepEqual(
  mixed.map((item) => item.logState),
  ['available', 'error', 'empty', 'available', 'available', 'not_requested']
)
const mixedPayload = {
  outcomes: mixed.map((item) => item.logState),
  textBytes: mixed.reduce((sum, item) => sum + Buffer.byteLength(item.logTail ?? ''), 0),
  jsonBytes: Buffer.byteLength(JSON.stringify({ jobs: mixed }))
}
host.prCheckLogTailCache.clear()
const cpu = []
for (const descriptor of cpuDescriptors) {
  const generated = workload(descriptor)
  const inputBytes = Buffer.byteLength(generated.text)
  const inputHash = hash(generated.text)
  assert.equal(inputBytes, descriptor.bytes)
  host.setFixtureOutput(generated.text)
  generated.text = ''
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  histogram.enable()
  await new Promise((resolve) => setTimeout(resolve, 10))
  histogram.reset()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const armed = performance.now()
  const timer = new Promise((resolve) => setTimeout(() => resolve(performance.now()), 5))
  const beforeCpu = process.cpuUsage()
  const started = performance.now()
  const jobs = [job(1000 + descriptor.bytes)]
  await host.attachFailedJobLogTails(jobs, repo, options, context)
  const wallMs = performance.now() - started
  const usedCpu = process.cpuUsage(beforeCpu)
  const fired = await timer
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert(histogram.count > 0)
  assert(
    jobs[0].logTail.includes('error: CPU_DIAGNOSTIC') &&
      jobs[0].logTail.includes('CPU_FRAME.ts:18:8')
  )
  cpu.push({
    workload: descriptor,
    inputBytes,
    inputHash,
    wallMs,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    timerLatenessMs: Math.max(0, fired - armed - 5),
    histogramMaxMs: histogram.max / 1e6,
    samples: histogram.count
  })
  histogram.disable()
  host.setFixtureOutput('')
  host.prCheckLogTailCache.clear()
}
const finalMemory = memory()
process.stdout.write(
  `${JSON.stringify({ trial: Number(trial), identityHash, runtime: { node: process.version, v8: process.versions.v8, uv: process.versions.uv, executableHash: hash(realpathSync(process.execPath)), platform: process.platform, arch: process.arch, gc: true, background: process.env.ORCA_BACKGROUND_LAUNCH === '1' }, pinnedControl, eight, nearCap, maximum, fullPayload, mixedPayload, cpu, finalMemory, activeTimeouts: process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length })}\n`
)
