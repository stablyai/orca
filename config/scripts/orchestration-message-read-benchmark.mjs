#!/usr/bin/env node
// Run: ORCA_BACKGROUND_LAUNCH=1 node config/scripts/orchestration-message-read-benchmark.mjs <baseline-sha>
import assert from 'node:assert/strict'
import { runProcessSync } from '@orca/process-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const inboxPath = 'src/main/runtime/orchestration/db/messages/message-inbox.ts'
const baselineSha = process.argv[2]
assert.match(baselineSha ?? '', /^[a-f0-9]{7,40}$/, 'Pass the unchanged baseline commit SHA.')
const source = runProcessSync({
  program: 'git',
  args: ['show', `${baselineSha}:${inboxPath}`],
  cwd: root,
  timeoutMs: 10_000
})
assert.equal(source.code, 0, source.stderr)
assert.equal(source.timedOut, false)
assert.ok(source.stdout.includes('SELECT * FROM messages'), 'Baseline must retain wildcard reads.')
const directory = await mkdtemp(join(tmpdir(), 'orca-message-read-benchmark-'))
const require = createRequire(import.meta.url)

async function loadDatabase(variant) {
  const output = join(directory, `${variant}.cjs`)
  await build({
    entryPoints: [join(root, 'src/main/runtime/orchestration/db.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output,
    plugins:
      variant === 'before'
        ? [
            {
              name: 'unchanged-production-inbox',
              setup(builder) {
                builder.onLoad({ filter: /message-inbox\.ts$/ }, () => ({
                  contents: source.stdout,
                  loader: 'ts'
                }))
              }
            }
          ]
        : []
  })
  return require(output).OrchestrationDb
}

function seed(db, handles, perHandle) {
  const insert = db.db.prepare(`INSERT INTO messages
    (id, run_id, from_handle, to_handle, subject, body, type, thread_id, created_at)
    VALUES (?, 'run_legacy_local', 'term_source', ?, ?, ?, ?, 'thread', '2026-10-13 01:02:03')`)
  db.db.exec('BEGIN')
  for (const handle of handles) {
    for (let index = 0; index < perHandle; index += 1) {
      const id = `${handle}:${index}`
      insert.run(id, handle, id, 'body'.repeat(64), index % 2 ? 'heartbeat' : 'status')
    }
  }
  db.db.exec('COMMIT')
}

function instrument(db) {
  const native = db.db.db
  const prepare = native.prepare.bind(native)
  let compilations = 0
  native.prepare = (sql) => {
    compilations += 1
    return prepare(sql)
  }
  return {
    count: () => compilations,
    reset: () => {
      compilations = 0
    },
    restore: () => {
      native.prepare = prepare
    }
  }
}

const scenarios = [
  { name: 'one empty mailbox', handles: 1, perHandle: 0, repeats: 2_000, mode: 'unread' },
  {
    name: 'four mailboxes, two messages each',
    handles: 4,
    perHandle: 2,
    repeats: 500,
    mode: 'unread'
  },
  { name: '100 mailbox idle edges', handles: 100, perHandle: 1, repeats: 20, mode: 'pending' },
  {
    name: '100-row batch in a 1,000-message mailbox',
    handles: 1,
    perHandle: 1_000,
    repeats: 250,
    mode: 'pending'
  },
  { name: 'by-id shared getter', handles: 1, perHandle: 1, repeats: 2_000, mode: 'by-id' },
  { name: 'unchanged history control', handles: 1, perHandle: 1, repeats: 1_000, mode: 'history' }
]

function read(db, handles, mode) {
  return handles.map((handle) => {
    if (mode === 'pending') {
      return db.getUndeliveredUnreadMessages(handle, undefined, {
        excludeTypes: ['heartbeat'],
        limit: 100
      })
    }
    if (mode === 'by-id') {
      return db.getMessageById(`${handle}:0`)
    }
    if (mode === 'history') {
      return db.getAllMessages(handle, 20)
    }
    return db.getUnreadMessages(handle)
  })
}

const median = (samples) => {
  const values = [...samples].sort((left, right) => left - right)
  const middle = values.length / 2
  return (values[middle - 1] + values[middle]) / 2
}

try {
  const constructors = { before: await loadDatabase('before'), after: await loadDatabase('after') }
  const rows = []
  for (const scenario of scenarios) {
    const handles = Array.from({ length: scenario.handles }, (_, index) => `term_${index}`)
    const arms = Object.entries(constructors).map(([variant, Database]) => {
      const db = new Database(':memory:')
      seed(db, handles, scenario.perHandle)
      return { variant, db, tracker: instrument(db), samples: [], compilations: 0 }
    })
    try {
      assert.deepEqual(
        read(arms[0].db, handles, scenario.mode),
        read(arms[1].db, handles, scenario.mode)
      )
      for (const arm of arms) {
        for (let warmup = 0; warmup < 10; warmup += 1) {
          read(arm.db, handles, scenario.mode)
        }
        arm.tracker.reset()
        for (let repeat = 0; repeat < scenario.repeats; repeat += 1) {
          read(arm.db, handles, scenario.mode)
        }
        arm.compilations = arm.tracker.count()
        arm.tracker.restore()
      }
      for (const pair of buildCounterbalancedSchedule(8, 'before', 'after')) {
        for (const variant of pair) {
          const arm = arms.find((candidate) => candidate.variant === variant)
          const started = performance.now()
          for (let repeat = 0; repeat < scenario.repeats; repeat += 1) {
            read(arm.db, handles, scenario.mode)
          }
          arm.samples.push((performance.now() - started) / scenario.repeats)
        }
      }
      const expectedCompilations = scenario.repeats * scenario.handles
      assert.equal(arms[0].compilations, expectedCompilations)
      assert.ok(
        arms[1].compilations === (scenario.mode === 'history' ? expectedCompilations : 0),
        `current compilation budget failed: ${scenario.name}`
      )
      rows.push({
        ...scenario,
        before: {
          medianMsPerPass: median(arms[0].samples),
          compilationsPerCountPass: arms[0].compilations,
          samples: arms[0].samples
        },
        after: {
          medianMsPerPass: median(arms[1].samples),
          compilationsPerCountPass: arms[1].compilations,
          samples: arms[1].samples
        }
      })
      for (const arm of arms) {
        assert.throws(
          () => arm.db.getUndeliveredUnreadMessages(handles[0], undefined, { limit: Number.NaN }),
          /datatype mismatch/
        )
        arm.db.markAsRead([`${handles[0]}:0`])
      }
      assert.deepEqual(
        read(arms[0].db, handles, scenario.mode),
        read(arms[1].db, handles, scenario.mode)
      )
    } finally {
      for (const arm of arms) {
        arm.db.close()
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        baselineSha,
        measurement:
          'Actual OrchestrationDb reads, warm in-memory SQLite, 8 counterbalanced pairs. Time per complete pass; compilation counts from a separate untimed pass. No app or network latency claim.',
        rows
      },
      null,
      2
    )
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
