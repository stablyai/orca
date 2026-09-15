import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const bundled = await build({
  stdin: {
    contents: "export * from './src/main/ai-vault/codex-session-root-dedup.ts'",
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const production = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

function baseline(input) {
  const sessions = []
  for (let offset = 0; offset < input.length; offset += 8) {
    sessions.push(...input.slice(offset, offset + 8))
    const unique = production.dedupeCodexSessionsBySessionId(sessions)
    sessions.splice(0, sessions.length, ...unique)
  }
  return sessions
}

function incremental(input) {
  const sessions = new production.CodexSessionCollection()
  for (let offset = 0; offset < input.length; offset += 8) {
    for (const session of input.slice(offset, offset + 8)) {
      sessions.add(session)
    }
  }
  return [...sessions.values()]
}

function makeSession(index, overrides = {}) {
  return Object.freeze({
    agent: 'codex',
    executionHostId: 'local',
    sessionId: `session-${index}`,
    filePath: `/home/ada/.codex/sessions/2026/09/11/rollout-session-${index}.jsonl`,
    codexHome: null,
    updatedAt: '2026-09-11T10:00:00.000Z',
    createdAt: null,
    modifiedAt: '2026-09-11T10:00:00.000Z',
    ...overrides
  })
}

function checkIdentities(actual, expected) {
  assert.equal(actual.length, expected.length)
  actual.forEach((session, index) => assert.equal(session, expected[index]))
}

let seed = 90211
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return Math.floor((seed / 0x100000000) * max)
}

if (production.CodexSessionCollection) {
  let batches = 0
  for (let trial = 0; trial < 2000; trial++) {
    const input = []
    const current = new production.CodexSessionCollection()
    let expected = []
    for (let batch = 0; batch < 20; batch++) {
      const added = Array.from({ length: 1 + random(8) }, () => {
        if (input.length && random(4) === 0) {
          return input[random(input.length)]
        }
        const index = random(12)
        const root = [
          '/home/ada/.codex',
          '/tmp/codex-runtime-home/home',
          '/tmp/codex-accounts/account/home',
          '/tmp/custom',
          '\\\\wsl$\\Ubuntu\\home\\ada\\.codex',
          '\\\\wsl.localhost\\ubuntu\\home\\ada\\.codex',
          '\\\\wsl$\\Debian\\home\\ada\\.codex',
          'C:\\Users\\Ada\\.codex'
        ][random(8)]
        return makeSession(index, {
          agent: random(6) ? 'codex' : 'claude',
          executionHostId: random(5) ? 'local' : 'ssh:dev',
          sessionId: `session-${random(3)}`,
          codexHome: random(4) ? root : null,
          filePath: `${root}/sessions/${random(6) ? 'rollout-' : ''}${index}.jsonl`,
          updatedAt: [null, 'invalid', '2026-09-11T10:00:00Z', '2026-09-11T10:01:00Z'][random(4)],
          modifiedAt: random(4) ? '2026-09-11T10:00:00Z' : 'invalid'
        })
      })
      input.push(...added)
      expected = production.dedupeCodexSessionsBySessionId([...expected, ...added])
      added.forEach((session) => current.add(session))
      checkIdentities([...current.values()], expected)
      assert.equal(current.size, expected.length)
      batches++
    }
  }
  console.log(JSON.stringify({ differentialBatches: batches }))
}

const workloads = []
if (process.argv.includes('--verify-only')) {
  process.exit(0)
}
for (const count of [8, 100, 1000, 5000, 10000]) {
  workloads.push([`${count} unique Codex`, Array.from({ length: count }, (_, i) => makeSession(i))])
  workloads.push([
    `${count} Claude`,
    Array.from({ length: count }, (_, i) => makeSession(i, { agent: 'claude' }))
  ])
}
for (const count of [1000, 5000]) {
  const input = Array.from({ length: count }, (_, i) => makeSession(i))
  const aliases = input.map((session) =>
    makeSession(0, {
      ...session,
      codexHome: '/tmp/custom',
      filePath: session.filePath.replace('/home/ada/.codex', '/tmp/custom')
    })
  )
  workloads.push([`${count} late preferred roots`, [...aliases, ...input]])
  workloads.push([`${count} late losing roots`, [...input, ...aliases]])
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

console.log(
  JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })
)
for (const [name, input] of workloads) {
  const expected = baseline(input)
  const arms = { baseline, ...(production.CodexSessionCollection ? { incremental } : {}) }
  const repeats = Math.max(1, Math.floor(5000 / input.length))
  const samples = { baseline: [], incremental: [] }
  for (const run of Object.values(arms)) {
    checkIdentities(run(input), expected)
  }
  for (const pair of buildCounterbalancedSchedule(8, 'baseline', 'incremental')) {
    for (const arm of pair) {
      if (!arms[arm]) {
        continue
      }
      const start = performance.now()
      let result
      for (let repeat = 0; repeat < repeats; repeat++) {
        result = arms[arm](input)
      }
      samples[arm].push((performance.now() - start) / repeats)
      checkIdentities(result, expected)
    }
  }
  console.log(
    JSON.stringify({
      name,
      medianMs: Object.fromEntries(
        Object.entries(samples)
          .filter(([, values]) => values.length)
          .map(([arm, values]) => [arm, median(values)])
      )
    })
  )
}

if (global.gc && production.CodexSessionCollection) {
  for (const count of [1000, 10000]) {
    const input = Array.from({ length: count }, (_, index) => makeSession(index))
    global.gc()
    const before = process.memoryUsage().heapUsed
    const collection = new production.CodexSessionCollection()
    input.forEach((session) => collection.add(session))
    global.gc()
    const retainedBytes = process.memoryUsage().heapUsed - before
    checkIdentities([...collection.values()], input)
    console.log(JSON.stringify({ name: `${count} scan-local index`, retainedBytes }))
  }
}
