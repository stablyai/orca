import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const sourceFile = 'mobile/src/worktree/structural-equality.ts'
const baselineFile = process.argv[2]
if (!baselineFile) {
  throw new Error(
    'Usage: node config/scripts/mobile-worktree-equality-benchmark.mjs <baseline-equality.ts>'
  )
}

async function loadModule(file, contents) {
  const compiled = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(file)) },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    tsconfigRaw: {}
  })
  const loaded = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
  )
  return loaded
}

const before = (await loadModule(sourceFile, readFileSync(baselineFile, 'utf8')))
  .areStructurallyEqual
const after = (await loadModule(sourceFile, readFileSync(sourceFile, 'utf8'))).areStructurallyEqual
const admissionFile = 'src/main/runtime/rpc/mobile-e2ee-outbound-admission.ts'
const admission = await loadModule(admissionFile, readFileSync(admissionFile, 'utf8'))
assert.equal(typeof before, 'function')
assert.equal(typeof after, 'function')

function catalogRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    workspaceKind: index % 2 === 0 ? 'git' : 'folder-workspace',
    worktreeId: `repo-1::workspace-${index}`,
    repoId: 'repo-1',
    hostId: 'ssh:build-host',
    terminalPlatform: 'linux',
    repo: 'orca',
    path: `workspaces/workspace-${index}`,
    branch: `feature/${index}`,
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: true,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: `workspace-${index}`,
    workspaceStatus: 'in-progress',
    sortOrder: index,
    lastActivityAt: 1234,
    createdAt: 1000,
    linkedPR: { number: index, state: 'open' },
    linkedIssue: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unverifiableTerminalCount: 0,
    lastOutputAt: 1234,
    preview: '',
    status: 'working',
    agents: [
      {
        paneKey: `agent-${index}`,
        parentPaneKey: null,
        state: 'working',
        agentType: 'codex',
        prompt: 'fix mobile lag',
        taskTitle: null,
        displayName: null,
        lastAssistantMessage: null,
        toolName: null,
        toolInput: null,
        interrupted: false,
        stateStartedAt: 100,
        updatedAt: 200,
        mainAgent: { state: 'working', stateStartedAt: 100 }
      }
    ]
  }))
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[4] + sorted[5]) / 2
}

const measurements = []
function measure(name, left, right, expected, count) {
  const comparators = { before, after }
  for (const compare of Object.values(comparators)) {
    assert.equal(compare(left, right), expected, name)
  }
  const iterations = count < 100 ? 100 : count < 1000 ? 20 : 50
  const samples = { before: [], after: [] }
  function run(arm) {
    const start = performance.now()
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      assert.equal(comparators[arm](left, right), expected)
    }
    return (performance.now() - start) / iterations
  }
  run('before')
  run('after')
  for (const pair of buildCounterbalancedSchedule(10, 'before', 'after')) {
    for (const arm of pair) {
      samples[arm].push(run(arm))
    }
  }
  measurements.push({
    name,
    count,
    medianMs: { before: median(samples.before), after: median(samples.after) },
    samples
  })
}

const payloadBytes = []
for (const count of [0, 1, 25, 200, 1000, 3000]) {
  const left = catalogRows(count)
  const right = structuredClone(left)
  const serializedReply = JSON.stringify({
    id: 'request-1',
    ok: true,
    result: { worktrees: left, totalCount: count, truncated: false }
  })
  const bytes = Buffer.byteLength(serializedReply)
  // Mobile encrypted replies admit at most 4 MiB of plaintext JSON.
  assert.ok(
    admission.isMobileE2EETextPayloadWithinLimit(serializedReply),
    `${count} rows exceed the production reply budget`
  )
  payloadBytes.push({ count, bytes })
  measure('same-reference', left, left, true, count)
  measure('equal-full-response', left, right, true, count)
  if (count > 0) {
    const firstChanged = structuredClone(right)
    firstChanged[0].agents[0].mainAgent.stateStartedAt = 101
    measure('first-row-changed', left, firstChanged, false, count)
    const lastChanged = structuredClone(right)
    lastChanged.at(-1).agents[0].mainAgent.stateStartedAt = 101
    measure('last-row-changed', left, lastChanged, false, count)
    measure('row-removed', left, right.slice(1), false, count)
    const reordered = right.map((row) => Object.fromEntries(Object.entries(row).toReversed()))
    measure('reordered-row-keys', left, reordered, true, count)
  }
}

function countedRows(count, changed = false) {
  let reads = 0
  const rows = Array.from({ length: count }, (_, index) => ({
    id: changed && index === 0 ? 'changed' : `row-${index}`
  }))
  rows.forEach((row, index) =>
    Object.defineProperty(rows, index, {
      enumerable: true,
      get: () => {
        reads += 1
        return row
      }
    })
  )
  return { rows, readCount: () => reads }
}

const rowReads = []
for (const [arm, compare] of Object.entries({ before, after })) {
  const left = countedRows(3000)
  const right = countedRows(3000, true)
  assert.equal(compare(left.rows, right.rows), false)
  rowReads.push({
    arm,
    firstChangeLeftReads: left.readCount(),
    firstChangeRightReads: right.readCount()
  })
}
assert.equal(rowReads[1].firstChangeLeftReads, rowReads[0].firstChangeLeftReads)
assert.equal(rowReads[1].firstChangeRightReads, rowReads[0].firstChangeRightReads)

const entryEnumerations = []
const entryLeft = catalogRows(3000)
const entryRight = structuredClone(entryLeft)
const nativeEntries = Object.entries
for (const [arm, compare] of nativeEntries({ before, after })) {
  let calls = 0
  Object.entries = (value) => {
    calls += 1
    return nativeEntries(value)
  }
  try {
    assert.equal(compare(entryLeft, entryRight), true)
  } finally {
    Object.entries = nativeEntries
  }
  entryEnumerations.push({ arm, calls })
}
assert.equal(entryEnumerations[1].calls, entryEnumerations[0].calls)

const mapAllocations = []
const NativeMap = globalThis.Map
for (const [arm, compare] of Object.entries({ before, after })) {
  let calls = 0
  class CountedMap extends NativeMap {
    constructor(entries) {
      super(entries)
      calls += 1
    }
  }
  globalThis.Map = CountedMap
  try {
    assert.equal(compare(entryLeft, entryRight), true)
  } finally {
    globalThis.Map = NativeMap
  }
  mapAllocations.push({ arm, calls })
}
assert.equal(mapAllocations[1].calls, 0)

const sparseShort = [1]
const sparseLong = [1]
sparseLong.length = 3
const specialRight = { b: 2 }
Object.defineProperty(specialRight, 'a', { value: 1, enumerable: false })
const controls = [
  [{ a: 1 }, { a: 1, b: undefined }, false],
  [{ a: undefined }, { b: undefined }, false],
  [{ a: 1 }, specialRight, false],
  [{ a: 1, b: 2 }, { b: 2, a: 1 }, true],
  [{ a: Number.NaN }, { a: Number.NaN }, true],
  [{ a: 0 }, { a: -0 }, false],
  [sparseShort, sparseLong, true],
  [Object.assign(Object.create(null), { a: 1 }), { a: 1 }, true],
  [[], {}, false]
]
for (const [left, right, expected] of controls) {
  assert.equal(before(left, right), expected)
  assert.equal(after(left, right), expected)
}
const mutableLeft = { state: { working: true } }
const mutableRight = structuredClone(mutableLeft)
assert.equal(after(mutableLeft, mutableRight), true)
mutableRight.state.working = false
assert.equal(after(mutableLeft, mutableRight), false)
const getterBehavior = []
for (const [arm, compare] of Object.entries({ before, after })) {
  const reads = []
  const left = {
    get a() {
      reads.push('left.a')
      return 1
    },
    get b() {
      reads.push('left.b')
      return 2
    }
  }
  const right = {
    get a() {
      reads.push('right.a')
      return 3
    },
    get b() {
      reads.push('right.b')
      return 2
    }
  }
  assert.equal(compare(left, right), false)
  assert.deepEqual(reads, ['left.a', 'left.b', 'right.a', 'right.b'])
  const mutable = { nested: { a: 1 }, later: 1 }
  const mutating = {
    nested: {
      get a() {
        mutable.later = 2
        return 1
      }
    },
    later: 1
  }
  assert.equal(compare(mutating, mutable), true)
  const failure = new Error('unreadable field')
  const throwing = {
    a: 2,
    get b() {
      throw failure
    }
  }
  assert.throws(
    () => compare({}, throwing),
    (error) => error === failure
  )
  assert.throws(
    () => compare({ a: 1, b: 1 }, throwing),
    (error) => error === failure
  )
  getterBehavior.push({ arm, reads, mutatedLater: mutable.later, throwsPreserved: true })
}
console.log(
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      payloadBytes,
      rowReads,
      entryEnumerations,
      mapAllocations,
      getterBehavior,
      controlsPassed: controls.length,
      measurements
    },
    null,
    2
  )
)
