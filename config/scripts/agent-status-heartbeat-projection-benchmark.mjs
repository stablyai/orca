import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const sourcePath = 'src/renderer/src/runtime/sync-runtime-graph/agent-status-projection.ts'
const sourceFile = path.join(root, sourcePath)
const baselineFile = process.argv[2]
if (!baselineFile) {
  throw new Error('Pass the saved baseline agent-status-projection.ts path, or - for stdin')
}
const baselineSource = readFileSync(baselineFile === '-' ? 0 : baselineFile, 'utf8')
const currentSource = readFileSync(sourceFile, 'utf8')
const hash = (text) => createHash('sha256').update(text).digest('hex')

async function loadProjection(source) {
  const result = await build({
    stdin: {
      contents: source,
      resolveDir: path.dirname(sourceFile),
      sourcefile: sourceFile,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    minify: true,
    write: false
  })
  const bundle = result.outputFiles[0].text
  const loaded = await import(
    `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`
  )
  return {
    project: loaded.buildRuntimeMobileAgentStatusProjection,
    reset: loaded.resetRuntimeMobileAgentStatusProjectionCacheForTests,
    bundleHash: hash(bundle)
  }
}

const baseline = await loadProjection(baselineSource)
const current = await loadProjection(currentSource)

async function loadStatusProducer() {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents:
        "export { normalizeAgentStatusPayload, AGENT_STATE_HISTORY_MAX } from './src/shared/agent-status-types'; export { buildAgentStatusLiveEntry } from './src/renderer/src/store/slices/agent-status-live-entry-builder';",
      resolveDir: root,
      sourcefile: path.join(root, 'agent-status-producer-benchmark-entry.ts'),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    minify: true,
    write: false,
    metafile: true,
    alias: { '@': path.join(root, 'src/renderer/src') },
    define: {
      'import.meta.env': '{}',
      ORCA_FEATURE_WALL_ENABLED: 'true',
      ORCA_BUILD_COMMIT: '"performance-benchmark"'
    }
  })
  const bundle = result.outputFiles[0].text
  const loaded = await import(
    `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`
  )
  const sourceHashes = Object.fromEntries(
    Object.keys(result.metafile.inputs)
      .filter(
        (file) => file !== 'agent-status-producer-benchmark-entry.ts' && !file.startsWith('<')
      )
      .map((file) => [file, hash(readFileSync(path.resolve(root, file), 'utf8'))])
  )
  return { ...loaded, sourceHashes, bundleHash: hash(bundle) }
}

const producer = await loadStatusProducer()

function fixture(rowCount, previewCharacters, historyCount, trigger) {
  assert.ok(historyCount <= producer.AGENT_STATE_HISTORY_MAX)
  const text = 'answer with "quotes", \\ paths and 日本 '
    .repeat(Math.ceil(previewCharacters / 36))
    .slice(0, previewCharacters)
  const payload = producer.normalizeAgentStatusPayload({
    state: trigger === 'question heartbeat' ? 'waiting' : 'working',
    prompt: text,
    agentType: 'claude',
    toolInput: text,
    lastAssistantMessage: text,
    mainAgent: { state: 'working', stateStartedAt: 29_900_000 },
    ...(trigger === 'question heartbeat'
      ? {
          interactivePrompt: JSON.stringify({
            questions: [{ question: 'question '.repeat(1_760), options: ['one', 'two'] }]
          })
        }
      : {})
  })
  assert.ok(payload)
  if (payload.interactivePrompt) {
    assert.ok(JSON.parse(payload.interactivePrompt))
  }
  const rows = {}
  let historyMaps = 0
  for (let index = 0; index < rowCount; index++) {
    const paneKey = `tab-${index}:11111111-1111-4111-8111-111111111111`
    const history = Array.from({ length: historyCount }, (_value, step) =>
      Object.freeze({ state: 'waiting', prompt: payload.prompt, startedAt: 29_000_000 + step })
    )
    Object.defineProperty(history, 'map', {
      get() {
        historyMaps++
        return Array.prototype.map
      }
    })
    rows[paneKey] = Object.freeze({
      ...payload,
      paneKey,
      updatedAt: 30_000_000,
      stateStartedAt: 29_900_000,
      terminalTitle: `Claude ${index}`,
      stateHistory: Object.freeze(history),
      mainAgent: Object.freeze(payload.mainAgent)
    })
  }
  const original = Object.freeze(rows)
  const state = {
    agentStatusByPaneKey: original,
    runtimeAgentOrchestrationByPaneKey: {},
    agentLaunchConfigByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    tabsByWorktree: {}
  }
  const heartbeat = Object.freeze(
    Object.fromEntries(
      Object.entries(rows).map(([key, row]) => {
        const nextPayload = producer.normalizeAgentStatusPayload({
          ...payload,
          ...(trigger === 'preview change'
            ? { lastAssistantMessage: `changed ${row.lastAssistantMessage}` }
            : {})
        })
        assert.ok(nextPayload)
        const updatedAt = row.updatedAt + (trigger === 'bucket change' ? 30_000 : 1)
        const built = producer.buildAgentStatusLiveEntry({
          state,
          paneKey: key,
          payload: nextPayload,
          timing: { updatedAt },
          routing: { tabId: key.slice(0, key.indexOf(':')), worktreeId: 'fixture' },
          updatedAt
        })
        assert.ok(built.entry)
        assert.equal(built.entry.stateHistory, row.stateHistory)
        assert.equal(built.entry.mainAgent, row.mainAgent)
        return [key, Object.freeze(built.entry)]
      })
    )
  )
  const fieldCharacters = {
    prompt: payload.prompt.length,
    toolInput: payload.toolInput?.length ?? 0,
    assistant: payload.lastAssistantMessage?.length ?? 0,
    question: payload.interactivePrompt?.length ?? 0,
    history: payload.prompt.length * historyCount
  }
  return {
    original,
    heartbeat,
    fieldCharacters,
    historyMaps: () => historyMaps,
    clearHistoryMaps: () => {
      historyMaps = 0
    }
  }
}

function capture(projection, maps) {
  projection.reset()
  return maps.map((map) => projection.project(map))
}

const control = fixture(3, 512, 2, 'same-bucket heartbeat')
const paneKey = Object.keys(control.original)[0]
const row = control.original[paneKey]
const changes = [
  { paneKey: 'different:leaf' },
  { state: 'done' },
  { workingMode: 'monitoring' },
  { prompt: 'changed' },
  { updatedAt: 30_030_000 },
  { stateStartedAt: 29_900_001 },
  { turnStartedAt: 29_900_001 },
  { agentType: 'codex' },
  { terminalTitle: 'changed' },
  { toolName: 'shell' },
  { toolInput: 'changed' },
  { interactivePrompt: '{"question":"ready?"}' },
  { lastAssistantMessage: 'changed' },
  { lastAssistantMessageIsToolOutput: true },
  { interrupted: true },
  { mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 29_900_001 } },
  { mainAgent: undefined },
  { stateHistory: [...row.stateHistory] },
  {
    stateHistory: [
      {
        state: 'done',
        prompt: 'changed',
        startedAt: 29_000_001,
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 29_000_001 }
      }
    ]
  },
  { updatedAt: 30_000_001, model: 'ignored field', acceptedStatusSeq: 2 },
  { toolInput: null, interactivePrompt: null, workingMode: null }
]
const controls = [control.original, control.heartbeat]
for (const change of changes) {
  controls.push(control.original, { ...control.original, [paneKey]: { ...row, ...change } })
}
const removed = { ...control.original }
delete removed[paneKey]
controls.push(removed, { ...removed, 'added:leaf': { ...row, paneKey: 'added:leaf' } }, {})
assert.deepEqual(capture(current, controls), capture(baseline, controls))

function measure(projection, input) {
  projection.reset()
  projection.project(input.original)
  const start = performance.now()
  projection.project(input.heartbeat)
  return performance.now() - start
}

function countHistoryMaps(projection, input) {
  projection.reset()
  projection.project(input.original)
  input.clearHistoryMaps()
  projection.project(input.heartbeat)
  return input.historyMaps()
}

function median(samples) {
  const ordered = [...samples].sort((a, b) => a - b)
  return (ordered[3] + ordered[4]) / 2
}

const results = []
for (const [rowCount, previewCharacters, historyCount, trigger] of [
  [1, 256, 0, 'same-bucket heartbeat'],
  [20, 256, 3, 'same-bucket heartbeat'],
  [500, 256, 3, 'same-bucket heartbeat'],
  [1, 8_000, 20, 'same-bucket heartbeat'],
  [20, 8_000, 20, 'same-bucket heartbeat'],
  [100, 8_000, 20, 'same-bucket heartbeat'],
  [500, 8_000, 20, 'same-bucket heartbeat'],
  [100, 8_000, 20, 'question heartbeat'],
  [500, 8_000, 20, 'question heartbeat'],
  [1, 256, 0, 'preview change'],
  [20, 256, 3, 'preview change'],
  [500, 256, 3, 'preview change'],
  [500, 8_000, 20, 'preview change'],
  [500, 256, 3, 'bucket change']
]) {
  const input = fixture(rowCount, previewCharacters, historyCount, trigger)
  assert.deepEqual(
    capture(current, [input.original, input.heartbeat]),
    capture(baseline, [input.original, input.heartbeat])
  )
  const baselineHistoryMaps = countHistoryMaps(baseline, input)
  const currentHistoryMaps = countHistoryMaps(current, input)
  assert.equal(baselineHistoryMaps, rowCount)
  assert.equal(currentHistoryMaps, trigger.endsWith('heartbeat') ? 0 : rowCount)
  for (let warmup = 0; warmup < 3; warmup++) {
    measure(baseline, input)
    measure(current, input)
  }
  const samples = { baseline: [], current: [] }
  for (let round = 0; round < 8; round++) {
    for (const arm of round % 2 === 0 ? ['baseline', 'current'] : ['current', 'baseline']) {
      samples[arm].push(measure(arm === 'baseline' ? baseline : current, input))
    }
  }
  results.push({
    trigger,
    rowCount,
    previewCharacters,
    historyCount,
    normalizedFieldCharacters: input.fieldCharacters,
    normalizedCharactersPerRow: Object.values(input.fieldCharacters).reduce(
      (sum, count) => sum + count,
      0
    ),
    baselineHistoryMaps,
    currentHistoryMaps,
    baselineMedianMs: median(samples.baseline),
    currentMedianMs: median(samples.current),
    samples
  })
}

process.stdout.write(
  `${JSON.stringify(
    {
      sourcePath,
      baselineSourceSha256: hash(baselineSource),
      currentSourceSha256: hash(currentSource),
      baselineBundleSha256: baseline.bundleHash,
      currentBundleSha256: current.bundleHash,
      producerBundleSha256: producer.bundleHash,
      producerSourceHashes: producer.sourceHashes,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      pairedRounds: 8,
      warmups: 3,
      parityFrames: controls.length,
      results
    },
    null,
    2
  )}\n`
)
