#!/usr/bin/env node
// Run with: node --expose-gc config/scripts/pi-tool-retention-benchmark.mjs <baseline rpc-messages.ts>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '../..')
const sourceDirectory = path.join(root, 'src/main/pi')
const baselinePath = process.argv[2]
if (!baselinePath) {
  throw new Error('Pass an unmodified baseline src/main/pi/rpc-messages.ts file')
}

async function loadImplementation(sourcePath) {
  const source = await readFile(sourcePath, 'utf8')
  const result = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: sourceDirectory },
    absWorkingDir: root,
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}

const before = await loadImplementation(path.resolve(baselinePath))
const after = await loadImplementation(path.join(sourceDirectory, 'rpc-messages.ts'))
const contextModule = await build({
  entryPoints: [path.join(sourceDirectory, 'rpc-context-usage.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const { PiRpcContextUsage } = await import(
  `data:text/javascript;base64,${Buffer.from(contextModule.outputFiles[0].text).toString('base64')}`
)

function makeFrames(toolCount, payloadBytes, updates) {
  const frames = []
  const payload = 'x'.repeat(payloadBytes)
  for (let index = 0; index < toolCount; index++) {
    frames.push({
      type: 'tool_execution_start',
      toolCallId: `tool-${index}`,
      toolName: 'bash',
      args: { command: payload },
      partialResult: { content: [{ type: 'text', text: payload }] }
    })
  }
  for (let index = 0; index < updates; index++) {
    frames.push({
      type: 'tool_execution_update',
      toolCallId: `tool-${index % toolCount}`,
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text: `${payload.slice(0, -8)}${index}` }] }
    })
  }
  for (let index = 0; index < toolCount; index++) {
    frames.push({ type: 'tool_execution_end', toolCallId: `tool-${index}`, toolName: 'bash' })
  }
  return frames
}

function run(implementation, frames, observe) {
  const messages = new implementation.PiRpcMessages('benchmark', new PiRpcContextUsage())
  let consumed = 0
  for (const frame of frames) {
    const events = messages.tool(frame)
    consumed += events[0].item.length
    observe?.(events)
  }
  messages.reset()
  return consumed
}

function parityDigest(implementation, frames) {
  const hash = createHash('sha256')
  run(implementation, frames, (events) => hash.update(JSON.stringify(events)))
  return hash.digest('hex')
}

function serializationCount(implementation, frames) {
  const stringify = JSON.stringify
  let calls = 0
  let bytes = 0
  JSON.stringify = function (value, replacer, space) {
    const encoded = stringify(value, replacer, space)
    if (value?.kind === 'tool-call') {
      calls++
      bytes += Buffer.byteLength(encoded)
    }
    return encoded
  }
  try {
    run(implementation, frames)
  } finally {
    JSON.stringify = stringify
  }
  return { calls, bytes }
}

function sample(implementation, frames) {
  global.gc?.()
  const cpuStart = process.cpuUsage()
  const start = performance.now()
  const consumed = run(implementation, frames)
  const wallMs = performance.now() - start
  const cpu = process.cpuUsage(cpuStart)
  return { wallMs, cpuMs: (cpu.user + cpu.system) / 1000, consumed }
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
}

const workloads = [
  { name: 'single-tool-control', tools: 1, payloadBytes: 1024, updates: 500 },
  { name: '16-running-tools', tools: 16, payloadBytes: 12 * 1024, updates: 500 },
  { name: '40-running-tools-near-byte-cap', tools: 40, payloadBytes: 12 * 1024, updates: 500 },
  { name: '128-small-running-tools', tools: 128, payloadBytes: 256, updates: 500 }
]
const results = []
const captures = []
const fixtureDirectory = path.join(sourceDirectory, '__fixtures__')
for (const name of await readdir(fixtureDirectory)) {
  if (!name.endsWith('.jsonl')) {
    continue
  }
  const frames = (await readFile(path.join(fixtureDirectory, name), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const envelope = JSON.parse(line)
      if (envelope.dir !== 'out') {
        return []
      }
      const frame = JSON.parse(envelope.raw)
      return ['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(
        frame.type
      )
        ? [frame]
        : []
    })
  const digest = parityDigest(before, frames)
  assert.equal(parityDigest(after, frames), digest, name)
  captures.push({ name, toolFrames: frames.length, paritySha256: digest })
}
for (const workload of workloads) {
  const frames = makeFrames(workload.tools, workload.payloadBytes, workload.updates)
  const digest = parityDigest(before, frames)
  assert.equal(parityDigest(after, frames), digest, workload.name)
  const beforeSerialization = serializationCount(before, frames)
  const afterSerialization = serializationCount(after, frames)
  run(before, frames)
  run(after, frames)
  const pairs = []
  for (let round = 0; round < 10; round++) {
    if (round % 2 === 0) {
      pairs.push({ before: sample(before, frames), after: sample(after, frames) })
    } else {
      const afterSample = sample(after, frames)
      pairs.push({ before: sample(before, frames), after: afterSample })
    }
  }
  for (const pair of pairs) {
    assert.equal(pair.before.consumed, pair.after.consumed)
  }
  results.push({
    ...workload,
    paritySha256: digest,
    beforeSerialization,
    afterSerialization,
    beforeMedianMs: median(pairs.map((pair) => pair.before.wallMs)),
    afterMedianMs: median(pairs.map((pair) => pair.after.wallMs)),
    beforeMedianCpuMs: median(pairs.map((pair) => pair.before.cpuMs)),
    afterMedianCpuMs: median(pairs.map((pair) => pair.after.cpuMs)),
    pairs
  })
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      baseline: pathToFileURL(path.resolve(baselinePath)).href,
      captures,
      results
    },
    null,
    2
  )
)
