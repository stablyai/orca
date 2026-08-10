import { performance } from 'node:perf_hooks'
import { platform, release } from 'node:os'
import {
  HEADER_LENGTH,
  MAX_MESSAGE_SIZE,
  MessageType,
  encodeFrame,
  encodePreparedJsonRpcFrame,
  prepareJsonRpcPayload,
  type JsonRpcNotification
} from '../../src/relay/protocol'

type BenchmarkCase = {
  name: string
  message: JsonRpcNotification
  targets: number
  iterations: number
}

type BenchmarkResult = {
  name: string
  targets: number
  payloadBytes: number
  legacyMicros: number
  preparedMicros: number
  reductionPercent: number
  speedup: number
}

const SAMPLES = 17
let checksum = 0

function encodeLegacyJsonRpcFrame(message: JsonRpcNotification, id: number, ack: number): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  if (payload.length > MAX_MESSAGE_SIZE) {
    throw new Error(`Message too large: ${payload.length} bytes`)
  }
  return encodeFrame(MessageType.Regular, id, ack, payload)
}

function runLegacy(message: JsonRpcNotification, targets: number, iteration: number): void {
  const estimated = encodeLegacyJsonRpcFrame(message, 0, 0).length
  checksum = (checksum + estimated) >>> 0
  for (let target = 0; target < targets; target++) {
    consume(encodeLegacyJsonRpcFrame(message, iteration + target + 1, iteration))
  }
}

function runPrepared(message: JsonRpcNotification, targets: number, iteration: number): void {
  const payload = prepareJsonRpcPayload(message)
  checksum = (checksum + HEADER_LENGTH + payload.byteLength) >>> 0
  for (let target = 0; target < targets; target++) {
    consume(encodePreparedJsonRpcFrame(payload, iteration + target + 1, iteration))
  }
}

function consume(frame: Buffer): void {
  checksum = (checksum + frame.length + frame[0] + frame.at(-1)!) >>> 0
}

function measure(operation: (iteration: number) => void, iterations: number): number {
  const startedAt = performance.now()
  for (let iteration = 0; iteration < iterations; iteration++) {
    operation(iteration)
  }
  return ((performance.now() - startedAt) * 1000) / iterations
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function benchmarkCase(entry: BenchmarkCase): BenchmarkResult {
  const legacy = (iteration: number): void => runLegacy(entry.message, entry.targets, iteration)
  const prepared = (iteration: number): void => runPrepared(entry.message, entry.targets, iteration)
  for (let warmup = 0; warmup < 3; warmup++) {
    measure(legacy, Math.min(20, entry.iterations))
    measure(prepared, Math.min(20, entry.iterations))
  }
  const legacySamples: number[] = []
  const preparedSamples: number[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    if (sample % 2 === 0) {
      legacySamples.push(measure(legacy, entry.iterations))
      preparedSamples.push(measure(prepared, entry.iterations))
    } else {
      preparedSamples.push(measure(prepared, entry.iterations))
      legacySamples.push(measure(legacy, entry.iterations))
    }
  }
  const legacyMicros = median(legacySamples)
  const preparedMicros = median(preparedSamples)
  return {
    name: entry.name,
    targets: entry.targets,
    payloadBytes: Buffer.byteLength(JSON.stringify(entry.message)),
    legacyMicros,
    preparedMicros,
    reductionPercent: ((legacyMicros - preparedMicros) / legacyMicros) * 100,
    speedup: legacyMicros / preparedMicros
  }
}

function terminalData(bytes: number): string {
  const row = '\u001b[38;5;45mcompile src/renderer/pane.ts\u001b[0m\r\n'
  return row.repeat(Math.ceil(bytes / row.length)).slice(0, bytes)
}

function watcherEvents(count: number): {
  kind: string
  absolutePath: string
  isDirectory: boolean
}[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: index % 7 === 0 ? 'create' : 'update',
    absolutePath: `/repo/src/features/terminal/generated-${String(index).padStart(4, '0')}.ts`,
    isDirectory: false
  }))
}

const ptyMessage: JsonRpcNotification = {
  jsonrpc: '2.0',
  method: 'pty.data',
  params: { id: 'pty-42', data: terminalData(16 * 1024), seq: 18_432, rawLength: 16 * 1024 }
}
const watcherMessage: JsonRpcNotification = {
  jsonrpc: '2.0',
  method: 'fs.changed',
  params: { events: watcherEvents(256) }
}
const fileMessage: JsonRpcNotification = {
  jsonrpc: '2.0',
  method: 'fs.streamChunk',
  params: {
    streamId: 37,
    seq: 11,
    data: Buffer.alloc(256 * 1024, 0x61).toString('base64')
  }
}

const cases: BenchmarkCase[] = [
  { name: 'PTY 16KiB', message: ptyMessage, targets: 1, iterations: 800 },
  { name: 'PTY 16KiB', message: ptyMessage, targets: 2, iterations: 600 },
  { name: 'watcher 256 events', message: watcherMessage, targets: 1, iterations: 400 },
  { name: 'watcher 256 events', message: watcherMessage, targets: 2, iterations: 300 },
  { name: 'file 256KiB raw', message: fileMessage, targets: 1, iterations: 50 },
  { name: 'file 256KiB raw', message: fileMessage, targets: 2, iterations: 35 }
]

const results = cases.map(benchmarkCase)
const lines = [
  `relay JSON payload benchmark: Node ${process.version}, ${platform()} ${release()}, ${SAMPLES} interleaved samples`,
  'case | targets | JSON bytes | legacy median us/op | prepared median us/op | reduction | speedup',
  ...results.map(
    (result) =>
      `${result.name} | ${result.targets} | ${result.payloadBytes} | ` +
      `${result.legacyMicros.toFixed(2)} | ${result.preparedMicros.toFixed(2)} | ` +
      `${result.reductionPercent.toFixed(1)}% | ${result.speedup.toFixed(2)}x`
  ),
  `checksum=${checksum}`,
  'Limitations: in-process framing only; excludes dispatcher scheduling, sink/network I/O, and tail-GC.',
  'Legacy is the exact pre-change framing composition retained in this script, not a separate checkout.',
  'The two-target rows model dispatcher fan-out; watcher batches and file streams are commonly single-target.'
]
process.stdout.write(`${lines.join('\n')}\n`)
