#!/usr/bin/env node
// Benchmark: cost of the owner-routed settings selector per store write.
//
// getSettingsForRepoRuntimeOwner() is called from useShallow selectors at ~43
// sites across PullRequestPage and TaskPage. Zustand re-runs every subscribed
// selector on every store write, so before the fix each unrelated write
// allocated one settings-sized object per row and then shallow-compared every
// field to conclude nothing had changed.
//
// The fix caches by repo id and reuses the reference while the settings object,
// repo list, and resolved owner are unchanged, so useShallow's equality check
// short-circuits on Object.is.
//
// The selector body is mirrored here (node cannot import the .ts source, matching
// the sibling benchmarks). The settings field count is read from the real
// GlobalSettings type so a drifted shape fails loudly instead of flattering the
// result with a stale, smaller object.
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const TYPES_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/shared/types.ts', import.meta.url)),
  'utf8'
)

function countGlobalSettingsFields(source) {
  const block = source.match(/export type GlobalSettings = \{([\s\S]*?)\n\}/)
  if (!block) {
    throw new Error('types.ts no longer declares GlobalSettings in the expected shape')
  }
  const fields = block[1].match(/^\s{2}\w+\??:/gm) ?? []
  if (fields.length < 50) {
    throw new Error(`GlobalSettings parsed as only ${fields.length} fields; re-sync this benchmark`)
  }
  return fields.length
}

const SETTINGS_FIELDS = countGlobalSettingsFields(TYPES_SOURCE)
const ROWS = Number.parseInt(process.env.ORCA_OWNER_SETTINGS_BENCH_ROWS ?? '43', 10)
const WRITES = Number.parseInt(process.env.ORCA_OWNER_SETTINGS_BENCH_WRITES ?? '2000', 10)
const WARMUP = Number.parseInt(process.env.ORCA_OWNER_SETTINGS_BENCH_WARMUP ?? '200', 10)

for (const [name, value] of [
  ['ORCA_OWNER_SETTINGS_BENCH_ROWS', ROWS],
  ['ORCA_OWNER_SETTINGS_BENCH_WRITES', WRITES],
  ['ORCA_OWNER_SETTINGS_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

function makeSettings() {
  const settings = { activeRuntimeEnvironmentId: 'focused-runtime' }
  for (let index = 0; index < SETTINGS_FIELDS - 1; index += 1) {
    settings[`field${index}`] = index % 3 === 0 ? `value-${index}` : index % 3 === 1 ? index : true
  }
  return settings
}

function makeRepos(rows) {
  return Array.from({ length: rows }, (_value, index) => ({
    id: `repo-${index}`,
    connectionId: null,
    executionHostId: `runtime:env-${index % 4}`
  }))
}

function resolveEnvironmentId(state, repoId) {
  if (!repoId) {
    return null
  }
  const matching = state.repos.filter((entry) => entry.id === repoId)
  const repo = matching.length === 1 ? matching[0] : null
  const hasOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasOwner) {
    const hostId = repo.executionHostId ?? ''
    return hostId.startsWith('runtime:') ? hostId.slice('runtime:'.length) : null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

// Pre-fix: a fresh object every call.
function selectorBefore(state, repoId) {
  return { ...state.settings, activeRuntimeEnvironmentId: resolveEnvironmentId(state, repoId) }
}

// Post-fix: reuse the reference while nothing it derives from changed.
function makeCachedSelector() {
  const cache = new Map()
  return (state, repoId) => {
    const environmentId = resolveEnvironmentId(state, repoId)
    const cacheKey = repoId ?? ''
    const cached = cache.get(cacheKey)
    if (
      cached &&
      cached.settingsSource === state.settings &&
      cached.reposSource === state.repos &&
      cached.environmentId === environmentId
    ) {
      return cached.value
    }
    const value = { ...state.settings, activeRuntimeEnvironmentId: environmentId }
    cache.set(cacheKey, {
      settingsSource: state.settings,
      reposSource: state.repos,
      environmentId,
      value
    })
    if (cache.size > 256) {
      const oldest = cache.keys().next()
      if (!oldest.done) {
        cache.delete(oldest.value)
      }
    }
    return value
  }
}

// Mirror of zustand's useShallow comparison.
function shallowEqual(a, b) {
  if (Object.is(a, b)) {
    return true
  }
  if (a === null || b === null || a === undefined || b === undefined) {
    return false
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) {
    return false
  }
  for (const key of keysA) {
    if (!Object.is(a[key], b[key])) {
      return false
    }
  }
  return true
}

// One unrelated store write: every subscribed row re-runs its selector and the
// result is compared against the previous one to decide whether to re-render.
function simulateWrite(selector, state, rows, previous) {
  let changed = 0
  for (let row = 0; row < rows; row += 1) {
    const next = selector(state, `repo-${row}`)
    if (!shallowEqual(previous[row], next)) {
      changed += 1
    }
    previous[row] = next
  }
  return changed
}

function measure(selector, state, rows) {
  const previous = Array.from({ length: rows }, () => null)
  for (let index = 0; index < WARMUP; index += 1) {
    simulateWrite(selector, state, rows, previous)
  }
  const samples = []
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now()
    for (let index = 0; index < WRITES; index += 1) {
      simulateWrite(selector, state, rows, previous)
    }
    samples.push((performance.now() - start) / WRITES)
  }
  samples.sort((a, b) => a - b)
  return samples[2]
}

const settings = makeSettings()
const rowCounts = [1, 10, ROWS, 100]
const rows = []
for (const rowCount of rowCounts) {
  const state = { repos: makeRepos(Math.max(rowCount, ROWS)), settings }
  const cached = makeCachedSelector()
  // Equivalence: both selectors must produce the same value for every row.
  for (let row = 0; row < rowCount; row += 1) {
    const before = selectorBefore(state, `repo-${row}`)
    const after = cached(state, `repo-${row}`)
    if (!shallowEqual(before, after)) {
      throw new Error(`selector mismatch at repo-${row}`)
    }
  }
  rows.push({
    rowCount,
    beforeMs: measure(selectorBefore, state, rowCount),
    afterMs: measure(makeCachedSelector(), state, rowCount)
  })
}

const pad = (value, width) => String(value).padStart(width)
console.log(`Owner-routed settings selector, per unrelated store write`)
console.log(
  `GlobalSettings fields=${SETTINGS_FIELDS} writes=${WRITES} warmup=${WARMUP} (median of 5 rounds)`
)
console.log(`${pad('rows', 6)} ${pad('before ms', 11)} ${pad('after ms', 10)} ${pad('speedup', 9)}`)
for (const row of rows) {
  console.log(
    `${pad(row.rowCount, 6)} ${pad(row.beforeMs.toFixed(4), 11)} ${pad(row.afterMs.toFixed(4), 10)} ${pad(`${(row.beforeMs / row.afterMs).toFixed(0)}x`, 9)}`
  )
}
console.log(
  `\nrows = subscribed selector call sites on screen (~${ROWS} across PullRequestPage/TaskPage).\nThe cost is paid on EVERY store write, including writes that touch nothing\nthese selectors read.`
)
