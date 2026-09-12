#!/usr/bin/env node
// Measures the no-URL PTY path that every terminal chunk enters.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import nodeModule from 'node:module'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})

const source = readFileSync(
  new URL('../../src/main/ports/advertised-url-watcher.ts', import.meta.url),
  'utf8'
)
for (const marker of [
  "return mayContainHttpUrl(finalized) ? stripTerminalControls(finalized) : ''",
  'if (chunk.length >= PER_PTY_BUFFER_LIMIT)',
  'this.raw.length + chunk.length > PER_PTY_BUFFER_LIMIT'
]) {
  if (!source.includes(marker)) {
    throw new Error(`advertised-url-watcher.ts no longer contains \`${marker}\``)
  }
}

const { AdvertisedUrlWatcher, extractUrlCandidates, stripTerminalControls } = await import(
  new URL('../../src/main/ports/advertised-url-watcher.ts', import.meta.url).href
)

const BUFFER_LIMIT = 4096
const ITERATIONS = Number(process.env.ORCA_ADVERTISED_URL_BENCH_ITERATIONS ?? '10000')
const ROUNDS = Number(process.env.ORCA_ADVERTISED_URL_BENCH_ROUNDS ?? '12')
const WARMUP = Number(process.env.ORCA_ADVERTISED_URL_BENCH_WARMUP ?? '1000')

for (const [name, value] of [
  ['ORCA_ADVERTISED_URL_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_ADVERTISED_URL_BENCH_ROUNDS', ROUNDS],
  ['ORCA_ADVERTISED_URL_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}
if (ROUNDS % 2 !== 0) {
  throw new Error('ORCA_ADVERTISED_URL_BENCH_ROUNDS must be even')
}

class BeforePtyBuffer {
  raw = ''

  ingest(chunk) {
    const chunkHasLineBreak = chunk.includes('\n') || chunk.includes('\r')
    this.raw += chunk
    if (this.raw.length > BUFFER_LIMIT) {
      this.raw = this.raw.slice(-BUFFER_LIMIT)
    }
    if (!chunkHasLineBreak) {
      return ''
    }
    const lastNewline = lastLineBreak(this.raw)
    if (lastNewline === -1) {
      return ''
    }
    const finalized = this.raw.slice(0, lastNewline + 1)
    this.raw = this.raw.slice(lastNewline + 1)
    return stripTerminalControls(finalized)
  }
}

class BeforeWatcher {
  buffers = new Map()
  ptyToWorktree = new Map()

  bindPty(ptyId, worktreeId) {
    this.ptyToWorktree.set(ptyId, worktreeId)
  }

  ingest(ptyId, chunk) {
    if (!this.ptyToWorktree.has(ptyId)) {
      return 0
    }
    let buffer = this.buffers.get(ptyId)
    if (!buffer) {
      buffer = new BeforePtyBuffer()
      this.buffers.set(ptyId, buffer)
    }
    const finalized = buffer.ingest(chunk)
    return finalized ? extractUrlCandidates(finalized).length : 0
  }
}

function lastLineBreak(text) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const code = text.charCodeAt(index)
    if (code === 0x0a || code === 0x0d) {
      return index
    }
  }
  return -1
}

function repeatToLine(text, length, sample) {
  const unit = `${text}${sample}\n`
  return `${unit.repeat(Math.ceil(length / unit.length)).slice(0, length - 1)}\n`
}

function repeatWithoutLineBreak(text, length, sample) {
  const unit = `${text}${sample}`
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
}

const fixtures = [
  {
    label: 'plain 32B line',
    chunks: Array.from({ length: 32 }, (_, index) => `compiled module ${index} in 183ms\n`)
  },
  {
    label: 'ANSI 32B line',
    chunks: Array.from({ length: 32 }, (_, index) => `\x1b[2K\x1b[1GThinking ${index}...\r\n`)
  },
  {
    label: 'guard fallthrough line',
    chunks: Array.from(
      { length: 32 },
      (_, index) => `path/to/http_server: compiled module ${index}\n`
    )
  },
  {
    label: 'plain 4KiB line',
    chunks: Array.from({ length: 32 }, (_, index) =>
      repeatToLine('INFO build completed module=renderer duration=12ms ', BUFFER_LIMIT, index)
    )
  },
  {
    label: 'ANSI 4KiB line',
    chunks: Array.from({ length: 32 }, (_, index) =>
      repeatToLine(
        '\x1b[2K\x1b[1Gthinking about compiler output and writing patches ',
        BUFFER_LIMIT,
        index
      )
    )
  },
  {
    label: 'guard fallthrough 4KiB',
    chunks: Array.from({ length: 32 }, (_, index) =>
      repeatToLine(
        'path/to/http_server: compiled without an advertised endpoint ',
        BUFFER_LIMIT,
        index
      )
    )
  },
  {
    label: '64KiB partial chunk',
    chunks: Array.from({ length: 32 }, (_, index) =>
      repeatWithoutLineBreak('compiler output without a line break ', 64 * 1024, index)
    )
  },
  {
    label: '256KiB partial chunk',
    chunks: Array.from({ length: 32 }, (_, index) =>
      repeatWithoutLineBreak('compiler output without a line break ', 256 * 1024, index)
    )
  }
]

let checksum = 0

function runBefore(chunks, iterations) {
  const watcher = new BeforeWatcher()
  watcher.bindPty('pty', 'repo::/bench')
  let found = 0
  for (let index = 0; index < iterations; index += 1) {
    found += watcher.ingest('pty', chunks[index % chunks.length])
  }
  checksum = Math.imul(checksum ^ found ^ watcher.buffers.get('pty').raw.length, 16777619) >>> 0
}

function runAfter(chunks, iterations) {
  const watcher = new AdvertisedUrlWatcher()
  watcher.bindPty('pty', 'repo::/bench')
  for (let index = 0; index < iterations; index += 1) {
    watcher.ingest('pty', chunks[index % chunks.length], index)
  }
  const buffer = watcher.buffers.get('pty')
  checksum = Math.imul(checksum ^ (buffer?.raw.length ?? 0), 16777619) >>> 0
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function measure(fixture) {
  runBefore(fixture.chunks, WARMUP)
  runAfter(fixture.chunks, WARMUP)
  const before = []
  const after = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const measureBefore = () => {
      const startedAt = performance.now()
      runBefore(fixture.chunks, ITERATIONS)
      before.push(((performance.now() - startedAt) * 1000) / ITERATIONS)
    }
    const measureAfter = () => {
      const startedAt = performance.now()
      runAfter(fixture.chunks, ITERATIONS)
      after.push(((performance.now() - startedAt) * 1000) / ITERATIONS)
    }
    if (round % 2 === 0) {
      measureBefore()
      measureAfter()
    } else {
      measureAfter()
      measureBefore()
    }
  }
  return { before: median(before), after: median(after) }
}

console.log('Advertised URL watcher no-match cost in microseconds/chunk. Lower is better.')
console.log(`iterations=${ITERATIONS}, rounds=${ROUNDS}, warmup=${WARMUP}`)
console.log('fixture                     before      after    speedup')
for (const fixture of fixtures) {
  const result = measure(fixture)
  console.log(
    `${fixture.label.padEnd(26)} ${result.before.toFixed(3).padStart(8)} ${result.after
      .toFixed(3)
      .padStart(10)} ${(result.before / result.after).toFixed(2).padStart(9)}x`
  )
}
console.log(`checksum=${checksum}`)
console.log(
  'Limitations: synthetic in-process scan; explicit timestamps omit the production clock read and surrounding PTY dispatch.'
)
