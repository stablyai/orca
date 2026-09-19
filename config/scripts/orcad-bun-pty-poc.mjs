#!/usr/bin/env bun

import { spawnBunPty } from '../../src/main/daemon/pty-subprocess/bun-pty-process.ts'
import {
  evaluateOrcadBunSoakBudget,
  parseOrcadBunSoakOptions,
  sampleOrcadBunSoakResources
} from './orcad-bun-soak-budget.mjs'

if (!globalThis.Bun?.Terminal) {
  throw new Error('This Bun runtime does not provide Bun.Terminal')
}

const INPUT_MARKER = 'ORCAD_BUN_PTY_INPUT'
const RESIZED_COLS = 97
const RESIZED_ROWS = 31
const options = parseOrcadBunSoakOptions(process.argv.slice(2))

const childSource = String.raw`
function dimensions() {
  const stream = process.platform === 'win32'
    ? new (require('node:tty').WriteStream)(1)
    : process.stdout
  return { columns: stream.columns, rows: stream.rows }
}
process.stdout.write(JSON.stringify({
  kind: 'ready',
  isTTY: process.stdout.isTTY === true,
  ...dimensions()
}) + '\n')
process.stdin.setEncoding('utf8')
process.stdin.once('data', (data) => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      kind: 'ack',
      input: data.trim(),
      ...dimensions()
    }) + '\n')
    process.exit(0)
  }, 25)
})
`

async function verifyPtyRoundTrip(cycle) {
  const marker = `${INPUT_MARKER}_${cycle}`
  const decoder = new TextDecoder()
  let output = ''
  let inputSent = false
  const proc = Bun.spawn([process.execPath, '-e', childSource], {
    timeout: 5_000,
    terminal: {
      cols: 80,
      rows: 24,
      data(terminal, bytes) {
        output += decoder.decode(bytes, { stream: true })
        if (!inputSent && output.includes('"kind":"ready"')) {
          inputSent = true
          terminal.resize(RESIZED_COLS, RESIZED_ROWS)
          // ConPTY's cooked input requires an Enter key, not a line feed.
          terminal.write(`${marker}\r`)
        }
      }
    }
  })
  const exitCode = await proc.exited
  await Bun.sleep(25)
  output += decoder.decode()
  proc.terminal?.close()
  const records = [...output.matchAll(/\{[^\r\n]+\}/g)]
    .map(([record]) => {
      try {
        return JSON.parse(record)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return {
    exitCode,
    marker,
    ready: records.find((record) => record.kind === 'ready'),
    ack: records.find((record) => record.kind === 'ack')
  }
}

async function verifyProducerBackpressure() {
  return await new Promise((resolvePromise, rejectPromise) => {
    let bytes = 0
    let pausedAt = 0
    let pausedGrowth = 0
    let resumedAt = 0
    let phase = 'streaming'
    const producerCommand =
      process.platform === 'win32'
        ? {
            file: process.execPath,
            args: [
              '-e',
              "const chunk='0123456789abcdef0123456789abcdef';for(;;)process.stdout.write(chunk)"
            ]
          }
        : {
            file: '/bin/sh',
            args: ['-c', "while :; do printf '0123456789abcdef0123456789abcdef'; done"]
          }
    const producer = spawnBunPty({
      ...producerCommand,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
      cols: 80,
      rows: 24
    })
    const timer = setTimeout(() => {
      producer.resume()
      producer.kill()
      rejectPromise(new Error('Bun PTY producer backpressure probe timed out'))
    }, 5_000)
    producer.onData((data) => {
      bytes += data.length
      if (phase !== 'streaming' || bytes < 64 * 1024) {
        return
      }
      phase = 'paused'
      producer.pause()
      pausedAt = bytes
      setTimeout(() => {
        pausedGrowth = bytes - pausedAt
        producer.resume()
        phase = 'resumed'
        resumedAt = bytes
        setTimeout(() => producer.kill(), 100)
      }, 200)
    })
    producer.onExit(() => {
      clearTimeout(timer)
      producer.destroy()
      resolvePromise({
        supported: true,
        pausedGrowth,
        resumedGrowth: bytes - resumedAt
      })
    })
  })
}

const failures = []
const samples = []
let lastRoundTrip = null
let lastBackpressure = null
let maxPausedGrowth = 0
let minResumedGrowth = Number.POSITIVE_INFINITY
for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
  const roundTrip = await verifyPtyRoundTrip(cycle)
  const backpressure = await verifyProducerBackpressure()
  const cycleFailures = [
    roundTrip.exitCode === 0 || `child exit code was ${roundTrip.exitCode}`,
    roundTrip.ready?.isTTY === true || 'child stdout was not a TTY',
    roundTrip.ack?.input === roundTrip.marker || 'terminal input did not round-trip',
    roundTrip.ack?.columns === RESIZED_COLS ||
      `resized columns were ${String(roundTrip.ack?.columns)}`,
    roundTrip.ack?.rows === RESIZED_ROWS || `resized rows were ${String(roundTrip.ack?.rows)}`,
    backpressure.pausedGrowth <= 256 * 1024 ||
      `paused producer emitted ${backpressure.pausedGrowth} extra bytes`,
    backpressure.resumedGrowth > 0 || 'producer did not resume after backpressure'
  ]
    .filter((result) => result !== true)
    .map((failure) => `cycle ${cycle}: ${failure}`)
  failures.push(...cycleFailures)
  lastRoundTrip = roundTrip
  lastBackpressure = backpressure
  maxPausedGrowth = Math.max(maxPausedGrowth, backpressure.pausedGrowth)
  minResumedGrowth = Math.min(minResumedGrowth, backpressure.resumedGrowth)
  samples.push(await sampleOrcadBunSoakResources(cycle))
  if (cycleFailures.length > 0) {
    break
  }
  if (options.cycles > 10 && cycle % 10 === 0) {
    process.stderr.write(`[orcad-bun-pty] completed ${cycle}/${options.cycles} cycles\n`)
  }
}
const resources = evaluateOrcadBunSoakBudget(samples, options.maxRssGrowthBytes)
failures.push(...resources.failures)

console.log(
  JSON.stringify({
    runtime: `bun ${Bun.version}`,
    platform: `${process.platform}-${process.arch}`,
    cycles: options.cycles,
    cyclesCompleted: samples.length,
    roundTrip: lastRoundTrip,
    backpressure: lastBackpressure,
    maxPausedGrowth,
    minResumedGrowth,
    resources,
    adapterBridges:
      process.platform === 'win32'
        ? ['job-owned producer suspension', 'per-PTY job ownership', 'ConPTY screen clear']
        : ['process-group producer suspension'],
    ok: failures.length === 0,
    failures
  })
)

if (failures.length > 0) {
  process.exit(1)
}
