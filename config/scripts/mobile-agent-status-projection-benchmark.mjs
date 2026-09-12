#!/usr/bin/env node
// Benchmark: cost of the mobile agent-status projection per store mutation.
//
// buildRuntimeMobileAgentStatusProjection runs on the App.tsx global store
// subscriber. setAgentStatus replaces one entry and re-spreads
// agentStatusByPaneKey, which defeats the reference-equality skip gate, so before
// the fix EVERY live agent was re-serialized on EVERY status ping — each carrying
// a prompt, a 20-entry stateHistory, toolInput, and an 8 KB-capped
// lastAssistantMessage.
//
// The fix memoizes each row's JSON by entry identity, mirroring the
// cachedTabsProjection pattern already in the same file, so a ping re-serializes
// only the agent that actually changed.
//
// The bucket width is re-read from the real module so a drifted constant fails
// loudly here instead of quietly changing what this benchmark measures.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const GRAPH_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/renderer/src/runtime/sync-runtime-graph.ts', import.meta.url)),
  'utf8'
)

const bucketMatch = GRAPH_SOURCE.match(/AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS = ([0-9_]+)/)
if (!bucketMatch) {
  throw new Error(
    'sync-runtime-graph.ts no longer defines the updatedAt bucket; re-sync this benchmark.'
  )
}
const BUCKET_MS = Number(bucketMatch[1].replaceAll('_', ''))

const ITERATIONS = Number.parseInt(process.env.ORCA_AGENT_PROJECTION_BENCH_ITERATIONS ?? '400', 10)
const WARMUP = Number.parseInt(process.env.ORCA_AGENT_PROJECTION_BENCH_WARMUP ?? '60', 10)

for (const [name, value] of [
  ['ORCA_AGENT_PROJECTION_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_AGENT_PROJECTION_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

function toRow(paneKey, entry) {
  return {
    paneKey,
    entryPaneKey: entry.paneKey,
    state: entry.state,
    prompt: entry.prompt,
    updatedAtBucket: Math.floor(entry.updatedAt / BUCKET_MS),
    stateStartedAt: entry.stateStartedAt,
    agentType: entry.agentType ?? null,
    terminalTitle: entry.terminalTitle ?? null,
    stateHistory: entry.stateHistory.map((history) => ({
      state: history.state,
      prompt: history.prompt,
      startedAt: history.startedAt,
      interrupted: history.interrupted ?? null
    })),
    toolName: entry.toolName ?? null,
    toolInput: entry.toolInput ?? null,
    interactivePrompt: entry.interactivePrompt ?? null,
    lastAssistantMessage: entry.lastAssistantMessage ?? null,
    interrupted: entry.interrupted ?? null
  }
}

function serializeEntry(paneKey, entry) {
  return JSON.stringify(toRow(paneKey, entry))
}

// Pre-fix: build plain rows and stringify the array once — no per-row roundtrip,
// which the original never paid and which would inflate the reported speedup.
function buildFull(map) {
  return JSON.stringify(
    Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([paneKey, entry]) => toRow(paneKey, entry))
  )
}

// Post-fix: reuse each row's JSON while its entry object is unchanged.
function makeCachedBuilder() {
  let cache = null
  return (map) => {
    if (cache?.source === map) {
      return cache.projection
    }
    const previous = cache?.entries
    const entries = new Map()
    const parts = []
    for (const [paneKey, entry] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
      const prior = previous?.get(paneKey)
      const row =
        prior?.entry === entry ? prior : { entry, projection: serializeEntry(paneKey, entry) }
      entries.set(paneKey, row)
      parts.push(row.projection)
    }
    const projection = `[${parts.join(',')}]`
    cache = { source: map, entries, projection }
    return projection
  }
}

// A live agent as the store actually holds it.
function makeEntry(index, updatedAt) {
  return {
    paneKey: `tab-${index}:leaf-0`,
    state: 'working',
    prompt: 'implement the feature and run the tests '.repeat(4),
    updatedAt,
    stateStartedAt: 1740000000000,
    agentType: 'claude',
    terminalTitle: `agent ${index}`,
    stateHistory: Array.from({ length: 20 }, (_value, step) => ({
      state: 'working',
      prompt: `step ${step} of the current turn`,
      startedAt: 1740000000000 + step,
      interrupted: null
    })),
    toolName: 'shell_command',
    toolInput: 'rg --line-number "pattern" src/ '.repeat(8),
    interactivePrompt: null,
    // The cap the store applies to assistant text.
    lastAssistantMessage: 'x'.repeat(8000),
    interrupted: null
  }
}

function makeMap(agents) {
  const map = {}
  for (let index = 0; index < agents; index += 1) {
    map[`tab-${index}:leaf-0`] = makeEntry(index, 1740000000000 + index * BUCKET_MS)
  }
  return map
}

// One status ping: one entry replaced, the map re-spread, every other entry
// reference-identical — exactly what setAgentStatus produces.
function ping(map, round) {
  return {
    ...map,
    'tab-0:leaf-0': makeEntry(0, 1740000000000 + BUCKET_MS * (round + 1))
  }
}

function measure(build, map) {
  let current = map
  for (let index = 0; index < WARMUP; index += 1) {
    current = ping(current, index)
    build(current)
  }
  const samples = []
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now()
    for (let index = 0; index < ITERATIONS; index += 1) {
      current = ping(current, index)
      build(current)
    }
    samples.push((performance.now() - start) / ITERATIONS)
  }
  samples.sort((a, b) => a - b)
  return samples[2]
}

const pad = (value, width) => String(value).padStart(width)
console.log('Mobile agent-status projection, per status ping (one agent changed)')
console.log(`bucket=${BUCKET_MS}ms iterations=${ITERATIONS} warmup=${WARMUP} (median of 5 rounds)`)
console.log(`${pad('agents', 8)} ${pad('full', 11)} ${pad('cached', 11)} ${pad('speedup', 9)}`)
for (const agents of [3, 8, 20, 40]) {
  const map = makeMap(agents)
  const cachedBuilder = makeCachedBuilder()
  if (buildFull(map) !== cachedBuilder(map)) {
    throw new Error(`projection mismatch at ${agents} agents`)
  }
  // Why also after a ping: the cold call reuses nothing, so a stale-row bug would
  // only surface once the cache is actually exercised.
  const pinged = ping(map, 0)
  if (buildFull(pinged) !== cachedBuilder(pinged)) {
    throw new Error(`projection mismatch after a ping at ${agents} agents`)
  }
  const full = measure(buildFull, map)
  const cached = measure(makeCachedBuilder(), map)
  console.log(
    `${pad(agents, 8)} ${pad(`${full.toFixed(4)} ms`, 11)} ${pad(`${cached.toFixed(4)} ms`, 11)} ${pad(`${(full / cached).toFixed(1)}x`, 9)}`
  )
}
console.log(
  '\nThis runs on the global store subscriber, so the cost is paid per status ping\nand scales with the number of agents running in parallel — the workload this\napp exists for.'
)
