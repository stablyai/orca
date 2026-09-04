#!/usr/bin/env node
// Benchmarks the three costs `setLocalWorkspaceSession` pays on every session write — the write
// that fires on something as ordinary as clicking between two terminal split panes.
//
//   1. capTerminalScrollbackSessionBuffer  — UTF-8 budget scan per retained scrollback buffer
//   2. remapPaneKeys                       — pane-key map rebuild that steady state throws away
//   3. writeTerminalScrollbackSnapshotSync — synchronous encode + write + rename per leaf
//
// Each scenario runs the production export against a baseline that reproduces the pre-change
// shape, so the reported speedup cannot drift away from what production actually does.
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import nodeModule from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

if (!process.execArgv.includes('--experimental-transform-types')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings', import.meta.filename],
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

// The app's TS sources import siblings without an extension; Node's ESM resolver needs it.
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (fs.existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})

const ROOT = path.resolve(import.meta.dirname, '../..')
const ROUNDS = Number(process.env.ORCA_SESSION_WRITE_BENCH_ROUNDS ?? '9')
const LEAVES = Number(process.env.ORCA_SESSION_WRITE_BENCH_LEAVES ?? '8')
const PANE_KEYS = Number(process.env.ORCA_SESSION_WRITE_BENCH_PANE_KEYS ?? '2000')

for (const [name, value] of [
  ['ORCA_SESSION_WRITE_BENCH_ROUNDS', ROUNDS],
  ['ORCA_SESSION_WRITE_BENCH_LEAVES', LEAVES],
  ['ORCA_SESSION_WRITE_BENCH_PANE_KEYS', PANE_KEYS]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`)
  }
}

const { capTerminalScrollbackSessionBuffer } = await import(
  path.join(ROOT, 'src/shared/workspace-session-terminal-buffers.ts')
)
const { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } = await import(
  path.join(ROOT, 'src/shared/terminal-scrollback-limits.ts')
)
const { remapAcknowledgedAgentPaneKeys } = await import(
  path.join(ROOT, 'src/main/persistence/restoring-sessions/pane-key-remapping.ts')
)
const { makePaneKey } = await import(path.join(ROOT, 'src/shared/stable-pane-id.ts'))
const { writeTerminalScrollbackSnapshotSync, resetTerminalScrollbackSnapshotWriteMemoryForTest } =
  await import(path.join(ROOT, 'src/main/terminal-scrollback-snapshots.ts'))

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function timeRounds(run) {
  const samples = []
  run()
  for (let round = 0; round < ROUNDS; round += 1) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

function report(label, baselineMs, currentMs, extra = '') {
  const speedup = baselineMs / currentMs
  console.log(
    `${label}\n  before ${baselineMs.toFixed(3)} ms → after ${currentMs.toFixed(3)} ms  (${speedup.toFixed(1)}x)${extra}`
  )
  return speedup
}

// ---------------------------------------------------------------- scenario 1

// Pre-change shape of measureUtf8ByteLength: two calls plus a Number.isFinite per code unit.
function baselineReadUtf8CodePointAt(text, index) {
  const leadUnit = text.charCodeAt(index)
  if (leadUnit < 0xd800 || leadUnit > 0xdbff || index + 1 >= text.length) {
    return leadUnit
  }
  const trailUnit = text.charCodeAt(index + 1)
  if (trailUnit < 0xdc00 || trailUnit > 0xdfff) {
    return leadUnit
  }
  return (leadUnit - 0xd800) * 0x400 + (trailUnit - 0xdc00) + 0x10000
}

function baselineUtf8ByteLengthForCodePoint(codePoint) {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

function baselineCapScrollbackBuffer(buffer) {
  if (buffer.length > TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT) {
    return buffer
  }
  const stopAfterBytes = TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
  let byteLength = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const codePoint = baselineReadUtf8CodePointAt(buffer, index)
    byteLength += baselineUtf8ByteLengthForCodePoint(codePoint)
    if (Number.isFinite(stopAfterBytes) && byteLength > stopAfterBytes) {
      return buffer
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return buffer
}

// A terminal that has been running a while sits at the cap, which is the case that scanned in full.
const scrollbackLine = `${'[0m'}build output line with a path /Users/dev/project/src/index.ts and a status ok\n`
let atCapBuffer = ''
while (atCapBuffer.length < TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT) {
  atCapBuffer += scrollbackLine
}
atCapBuffer = atCapBuffer.slice(0, TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT)

if (capTerminalScrollbackSessionBuffer(atCapBuffer) !== baselineCapScrollbackBuffer(atCapBuffer)) {
  throw new Error('scrollback cap disagreed with the baseline implementation')
}

// The session write runs the prune twice, once per retained leaf.
const CAP_CALLS_PER_WRITE = LEAVES * 2
const capBaselineMs = timeRounds(() => {
  for (let call = 0; call < CAP_CALLS_PER_WRITE; call += 1) {
    baselineCapScrollbackBuffer(atCapBuffer)
  }
})
const capCurrentMs = timeRounds(() => {
  for (let call = 0; call < CAP_CALLS_PER_WRITE; call += 1) {
    capTerminalScrollbackSessionBuffer(atCapBuffer)
  }
})

console.log(
  `Session-write hot path — ${LEAVES} retained scrollback leaves, ${PANE_KEYS} accumulated pane keys\n`
)
report(
  `1. scrollback UTF-8 budget scan (${CAP_CALLS_PER_WRITE} calls/write @ ${(atCapBuffer.length / 1024).toFixed(0)} KB)`,
  capBaselineMs,
  capCurrentMs
)

// ---------------------------------------------------------------- scenario 2

const paneKeys = {}
const leafIdByInputLeafIdByTabId = new Map()
for (let index = 0; index < PANE_KEYS; index += 1) {
  const tabId = `tab-${index % 64}`
  const leafId = `${(index % 64).toString(16).padStart(8, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
  paneKeys[makePaneKey(tabId, leafId)] = index
  let leaves = leafIdByInputLeafIdByTabId.get(tabId)
  if (!leaves) {
    leaves = new Map()
    leafIdByInputLeafIdByTabId.set(tabId, leaves)
  }
  // Steady state: a stable UUID leaf maps to itself.
  leaves.set(leafId, leafId)
}

function baselineRemapPaneKeys(values, remap) {
  if (!values || Object.keys(values).length === 0) {
    return { values, changed: false }
  }
  let changed = false
  const next = {}
  const setValue = (paneKey, value) => {
    const existing = next[paneKey]
    next[paneKey] = existing === undefined ? value : Math.max(existing, value)
  }
  for (const [paneKey, value] of Object.entries(values)) {
    const delimiter = paneKey.indexOf(':')
    if (delimiter <= 0 || delimiter === paneKey.length - 1) {
      setValue(paneKey, value)
      continue
    }
    const remapped = remap.get(paneKey.slice(0, delimiter))?.get(paneKey.slice(delimiter + 1))
    if (!remapped) {
      setValue(paneKey, value)
      continue
    }
    setValue(paneKey, value)
  }
  return { values: next, changed }
}

// The write remaps three of these maps: acknowledgements, activity cutoffs, manual unread.
const REMAP_CALLS_PER_WRITE = 3
const remapBaselineMs = timeRounds(() => {
  for (let call = 0; call < REMAP_CALLS_PER_WRITE; call += 1) {
    baselineRemapPaneKeys(paneKeys, leafIdByInputLeafIdByTabId)
  }
})
const remapCurrentMs = timeRounds(() => {
  for (let call = 0; call < REMAP_CALLS_PER_WRITE; call += 1) {
    remapAcknowledgedAgentPaneKeys(paneKeys, leafIdByInputLeafIdByTabId)
  }
})
const remapResult = remapAcknowledgedAgentPaneKeys(paneKeys, leafIdByInputLeafIdByTabId)
if (remapResult.changed || remapResult.acknowledgements !== paneKeys) {
  throw new Error('steady-state remap should return the input map untouched')
}
report(
  `2. pane-key remap (${REMAP_CALLS_PER_WRITE} maps/write @ ${PANE_KEYS} keys)`,
  remapBaselineMs,
  remapCurrentMs,
  '  — and 3 discarded objects/write become 0'
)

// ---------------------------------------------------------------- scenario 3

const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-session-write-bench-'))
try {
  const storage = { snapshotRoot, fallbackSnapshotRoot: null }
  const leaves = Array.from({ length: LEAVES }, (_, index) => ({
    tabId: 'slept-tab',
    leafId: `leaf-${index}`,
    buffer: atCapBuffer,
    storage
  }))
  const writeAll = () => {
    for (const leaf of leaves) {
      writeTerminalScrollbackSnapshotSync(leaf)
    }
  }
  // Baseline: what a republish cost before, i.e. every leaf reaching disk every time.
  const alwaysWriteMs = timeRounds(() => {
    resetTerminalScrollbackSnapshotWriteMemoryForTest()
    writeAll()
  })
  writeAll()
  const republishMs = timeRounds(writeAll)
  const writtenFiles = fs.readdirSync(snapshotRoot).filter((name) => !name.endsWith('.tmp'))
  if (writtenFiles.length !== LEAVES) {
    throw new Error(`expected ${LEAVES} snapshot files, found ${writtenFiles.length}`)
  }
  const republishedBytes = writtenFiles.reduce(
    (total, name) => total + fs.statSync(path.join(snapshotRoot, name)).size,
    0
  )
  report(
    `3. scrollback snapshot republish (${LEAVES} unchanged leaves/write)`,
    alwaysWriteMs,
    republishMs,
    `  — ${(republishedBytes / 1024 / 1024).toFixed(2)} MB of disk writes per session write become 0`
  )
} finally {
  fs.rmSync(snapshotRoot, { recursive: true, force: true })
}
