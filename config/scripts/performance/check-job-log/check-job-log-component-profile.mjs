import assert from 'node:assert/strict'
import { Session } from 'node:inspector/promises'
import { performance } from 'node:perf_hooks'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { prepareBenchmark, hash } from './check-job-log-byte-cap-benchmark.mjs'
import { workload } from './check-job-log-performance-cases.mjs'

assert(!process.versions.bun && typeof globalThis.gc === 'function')
const context = await prepareBenchmark(process.cwd(), { profile: true })
const records = []
const profileNames = [
  'isUtf8ByteLengthWithinLimit',
  'hasErrorMarker',
  'matches',
  'matchesErrorMarker',
  'stripAnsiEscapeSequences',
  'stripControlStrings',
  'appendSpan',
  'ownRetainedString',
  'copyUtf16SuffixToOwnedString'
]
async function measure(name, operation, calls, input) {
  for (let warmup = 0; warmup < 3; warmup++) {
    operation()
  }
  globalThis.gc()
  const session = new Session()
  session.connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: 100 })
    await session.post('Profiler.start')
    const cpuBefore = process.cpuUsage()
    const started = performance.now()
    for (let call = 0; call < calls; call++) {
      operation()
    }
    const wallMs = performance.now() - started
    const cpu = process.cpuUsage(cpuBefore)
    const { profile } = await session.post('Profiler.stop')
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
    const parents = new Map(
      profile.nodes.flatMap((node) => (node.children ?? []).map((id) => [id, node.id]))
    )
    const timings = Object.fromEntries(
      profileNames.map((fn) => [fn, { selfMs: 0, inclusiveMs: 0 }])
    )
    for (let sample = 0; sample < (profile.samples?.length ?? 0); sample++) {
      let id = profile.samples[sample]
      const duration = profile.timeDeltas[sample] / 1000
      const fn = nodes.get(id)?.callFrame.functionName
      if (timings[fn]) {
        timings[fn].selfMs += duration
      }
      const names = new Set()
      while (id !== undefined) {
        names.add(nodes.get(id)?.callFrame.functionName)
        id = parents.get(id)
      }
      for (const fn of names) {
        if (timings[fn]) {
          timings[fn].inclusiveMs += duration
        }
      }
    }
    records.push({
      name,
      calls,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      inputBytes: Buffer.byteLength(input),
      codeUnits: input.length,
      inputHash: hash(input),
      timings
    })
  } finally {
    session.disconnect()
  }
}
try {
  const module = await import(pathToFileURL(context.bundles.proposed.filename).href)
  const line = workload({ mode: 'cpu', family: 'short-lines', bytes: 8 * 1024 * 1024 }).text.split(
    '\n'
  )[0]
  const count = 100000
  await measure(
    'bounded-byte-fit',
    () => module.isUtf8ByteLengthWithinLimit(line, 16384),
    count,
    line
  )
  await measure('candidate-stripper', () => module.stripAnsiEscapeSequences(line), count, line)
  const plain = module.stripAnsiEscapeSequences(line)
  await measure(
    'candidate-control-cleanup',
    () => plain.replace(module.TERMINAL_CONTROL_CHARACTER_PATTERN, ''),
    count,
    plain
  )
  await measure('candidate-total', () => module.hasErrorMarker(line), count, line)
  for (const bytes of [8 * 1024 * 1024, 63 * 1024 * 1024]) {
    let input = workload({ mode: 'cpu', family: 'short-lines', bytes }).text
    await measure(
      `extraction-short-lines-${bytes}`,
      () => module.sliceCheckLogTail(input),
      3,
      input
    )
    input = ''
  }
  for (const family of ['dense-osc', 'dense-string', 'sparse', 'mixed']) {
    let input = workload({
      mode: 'direct',
      family,
      width: family === 'mixed' ? 0 : 7,
      bytes: 8 * 1024 * 1024,
      variant: 'unfinished'
    }).text
    await measure(`collector-${family}`, () => module.stripAnsiEscapeSequences(input), 3, input)
    input = ''
  }
  if (process.env.ORCA_CHECK_LOG_CAPTURE) {
    let input = await readFile(process.env.ORCA_CHECK_LOG_CAPTURE, 'utf8')
    await measure('extraction-actual', () => module.sliceCheckLogTail(input), 15, input)
    input = ''
  }
  const report = {
    identity: context.identity,
    profilerScriptHash: hash(await readFile(new URL(import.meta.url))),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    purpose: 'Targeted sampled diagnosis; instrumentation timings are not acceptance medians',
    records
  }
  assert(process.env.ORCA_CHECK_LOG_PROFILE_REPORT)
  await writeFile(process.env.ORCA_CHECK_LOG_PROFILE_REPORT, JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      records.map(({ name, wallMs, cpuMs, timings }) => ({ name, wallMs, cpuMs, timings }))
    )
  )
} finally {
  await context.cleanup()
}
