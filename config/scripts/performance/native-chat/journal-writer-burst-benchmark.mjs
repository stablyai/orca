#!/usr/bin/env node
// Restart-burst load on the chat journal writer: N chats stream into one large domain database while a probe
// chat sends, and we measure how long the probe's writes wait for their acknowledgement.
// Usage: node journal-writer-burst-benchmark.mjs --dir <cache dir> [--rows 3200000] [--sessions 1,25,50]
//   [--seconds 60] [--arms base=<ref>,new=<ref>] [--rounds 2] [--cpu-load <workers>] [--readers <n>] [--out <json>]
// Each arm bundles the writer from that git ref, so arms run back to back against the same seeded file.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (pairs, value, index, all) =>
        index % 2 === 0 ? [...pairs, [value.replace(/^--/, ''), all[index + 1]]] : pairs,
      []
    )
)
const dir = resolve(args.dir ?? join(tmpdir(), 'orca-journal-burst'))
const rows = Number(args.rows ?? 3_200_000)
const sessionCounts = String(args.sessions ?? '1,25,50')
  .split(',')
  .map(Number)
const seconds = Number(args.seconds ?? 60)
const rounds = Number(args.rounds ?? 2)
const cpuLoad = Number(args['cpu-load'] ?? 0)
const readerThreads = Number(args.readers ?? 0)
const arms = String(args.arms ?? 'head=HEAD')
  .split(',')
  .map((entry) => entry.split('='))
const TEMPLATE_ITEMS = 300
// --db runs against an existing file (an APFS clone of a real chat database) instead of seeding one.
const filename = args.db ? resolve(args.db) : join(dir, 'bench-domain.db')
const journal = 'src/main/native-chat/agent-session-journal'

async function bundleArm(name, ref) {
  const out = join(dir, 'arms', name)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const source = mkdtempSync(join(tmpdir(), `journal-burst-${name}-`))
  execFileSync('sh', ['-c', `git -C '${root}' archive '${ref}' src | tar -x -C '${source}'`])
  await build({
    entryPoints: {
      owner: join(source, journal, 'journal-sql-owner.ts'),
      schema: join(source, journal, 'database/journal-domain-database.ts'),
      'journal-sql-worker-entry': join(source, journal, 'journal-sql-worker-entry.ts')
    },
    outdir: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    nodePaths: [join(root, 'node_modules')],
    logLevel: 'silent'
  })
  rmSync(source, { recursive: true, force: true })
  const require = createRequire(join(out, 'owner.js'))
  return {
    name,
    ref,
    sha: execFileSync('git', ['-C', root, 'rev-parse', ref]).toString().trim(),
    JournalSqlOwner: require('./owner.js').JournalSqlOwner,
    openJournalDomainDatabase: require('./schema.js').openJournalDomainDatabase,
    workerPath: join(out, 'journal-sql-worker-entry.js')
  }
}

const options = { fence: 1, turnScope: { kind: 'thread' } }
const filler = (length, seed) =>
  `${seed} `.repeat(Math.ceil(length / (seed.length + 1))).slice(0, length)
const message = (clientMessageId, role, text, completed) => ({
  identity: { provider: 'orca', clientMessageId },
  body: {
    kind: 'message',
    role,
    blocks: [{ type: 'text', text }],
    ...(completed ? { completedAt: Date.now() } : {})
  },
  options
})
const itemStep = (step) => ({
  kind: 'item',
  reservedBytes: Buffer.byteLength(JSON.stringify(step)) + 512,
  ...step
})
const textStep = (step) => ({
  kind: 'resolved-item',
  reservedBytes: Buffer.byteLength(JSON.stringify(step)) + 512,
  options: step.options,
  resolution: { kind: 'text-snapshot', identity: step.identity, body: step.body }
})
const stepsCommand = (sessionId, steps) => ({
  target: { sessionId, epoch: 'epoch', ownerToken: 'bench' },
  savedAt: Date.now(),
  operation: { kind: 'steps', steps }
})

async function seed(arm) {
  if (args.db) {
    const { db } = arm.openJournalDomainDatabase(filename)
    const chat = db.prepare(
      `INSERT OR IGNORE INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('w',?,'epoch',1,1)`
    )
    for (let index = 0; index < 64; index++) {
      chat.run(`burst-${index}`)
    }
    chat.run('probe')
    db.close()
    return
  }
  const marker = `${filename}.seeded-${rows}`
  if (existsSync(marker)) {
    return
  }
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${filename}${suffix}`, { force: true })
  }
  const { db } = arm.openJournalDomainDatabase(filename)
  const chat = db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('w',?,'epoch',1,1)`
  )
  chat.run('template')
  for (let index = 0; index < 64; index++) {
    chat.run(`burst-${index}`)
  }
  chat.run('probe')
  db.close()
  const owner = new arm.JournalSqlOwner(filename, dir, arm.workerPath)
  await owner.opened()
  for (let index = 0; index < TEMPLATE_ITEMS; index += 10) {
    const steps = Array.from({ length: 10 }, (_, offset) =>
      itemStep(
        message(
          `template-${index + offset}`,
          'assistant',
          filler(1800, `row${index + offset}`),
          true
        )
      )
    )
    await owner.write(stepsCommand('template', steps))
  }
  await owner.close()
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(filename)
  raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF')
  const tables = raw
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map(({ name }) => ({
      name,
      columns: raw
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .all(name)
        .map((column) => column.name)
    }))
    .filter(({ columns }) => columns.includes('session_id'))
  const copies = Math.ceil(rows / TEMPLATE_ITEMS)
  const statements = tables.map(({ name, columns }) =>
    raw.prepare(
      `INSERT OR IGNORE INTO ${name}(${columns.join(',')}) SELECT ${columns
        .map((column) => (column === 'session_id' ? '?' : column))
        .join(',')} FROM ${name} WHERE session_id='template'`
    )
  )
  const startedAt = Date.now()
  for (let copy = 0; copy < copies; copy += 200) {
    raw.exec('BEGIN')
    for (let index = copy; index < Math.min(copies, copy + 200); index++) {
      for (const statement of statements) {
        statement.run(`seed-${index}`)
      }
    }
    raw.exec('COMMIT')
    console.error(
      `seeded ${Math.min(copies, copy + 200)}/${copies} chats (${Math.round((Date.now() - startedAt) / 1000)} s)`
    )
  }
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  raw.close()
  writeFileSync(marker, new Date().toISOString())
}

/** One streaming chat: one write in flight, later text and items coalesced into the next, as the sink queue does. */
function stream(owner, sessionId, stopAt, onWrite) {
  let inflight = false
  let text = null
  let items = []
  let turn = 0
  let length = 0
  let tool = 0
  const timers = []
  const pump = () => {
    if (inflight || (text === null && items.length === 0)) {
      return
    }
    const steps = [...items.map(itemStep), ...(text ? [textStep(text)] : [])]
    items = []
    text = null
    inflight = true
    const startedAt = performance.now()
    owner
      .write(stepsCommand(sessionId, steps))
      .catch(() => undefined)
      .finally(() => {
        onWrite(performance.now() - startedAt)
        inflight = false
        if (Date.now() < stopAt) {
          pump()
        }
      })
  }
  timers.push(
    setInterval(() => {
      length += 180
      if (length > 6000) {
        items.push(message(`${sessionId}-m${turn}`, 'assistant', filler(6000, `m${turn}`), true))
        turn++
        length = 180
      }
      text = message(`${sessionId}-m${turn}`, 'assistant', filler(length, `m${turn}`), false)
      pump()
    }, 80)
  )
  timers.push(
    setInterval(() => {
      const id = `${sessionId}-t${tool++}`
      items.push(message(id, 'assistant', filler(3500, id), false))
      setTimeout(() => {
        items.push(message(id, 'assistant', filler(3800, id), true))
        pump()
      }, 700)
      pump()
    }, 1500)
  )
  return () => timers.forEach(clearInterval)
}

function startReaders(count) {
  const source = `
    const { workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.filename, { readOnly: true });
    const read = db.prepare("SELECT length(payload_json) AS bytes FROM journal_items WHERE session_id=? ORDER BY ordinal LIMIT 400");
    const sessions = db.prepare("SELECT session_id FROM journal_chat_state WHERE session_id NOT LIKE 'burst-%' LIMIT 2000").all().map((row) => row.session_id);
    const loop = () => {
      db.exec('BEGIN');
      read.all(sessions[Math.floor(Math.random() * sessions.length)]);
      setTimeout(() => { db.exec('COMMIT'); setTimeout(loop, 20); }, 400);
    };
    loop();`
  return Array.from(
    { length: count },
    () =>
      new Worker(source, {
        eval: true,
        workerData: { filename, copies: Math.ceil(rows / TEMPLATE_ITEMS) }
      })
  )
}

const quantile = (values, q) => {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
}
const summary = (values) => ({
  n: values.length,
  p50: quantile(values, 0.5),
  p90: quantile(values, 0.9),
  max: quantile(values, 1)
})

async function run(arm, sessions) {
  const owner = new arm.JournalSqlOwner(filename, dir, arm.workerPath)
  await owner.opened()
  const timings = []
  owner.onTiming = (roundTripMs, timing) => timings.push({ roundTripMs, ...timing })
  const streamWrites = []
  const stopAt = Date.now() + seconds * 1000
  const stops = Array.from({ length: sessions }, (_, index) =>
    stream(owner, `burst-${index}`, stopAt, (ms) => streamWrites.push(ms))
  )
  const probe = []
  const chain = []
  await new Promise((resolve) => setTimeout(resolve, 3000))
  // A sending chat's writes carry `urgent`, as the store marks them; builds without the lane ignore it.
  const control = (label) => ({
    urgent: true,
    target: { sessionId: 'probe', epoch: 'epoch', ownerToken: 'bench' },
    savedAt: Date.now(),
    operation: {
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: label },
      body: { kind: 'status', text: label },
      options
    }
  })
  // Handover, then (timed) the turn item and the accepted receipt, as a send's journal chain runs.
  for (let index = 0; Date.now() < stopAt - 3000; index++) {
    const label = `probe-${arm.name}-${sessions}-${Date.now()}-${index}`
    await owner.write(control(`${label}-handover`))
    const startedAt = performance.now()
    await owner.write({
      ...stepsCommand('probe', [itemStep(message(`${label}-turn`, 'assistant', 'turn', false))]),
      urgent: true
    })
    probe.push(performance.now() - startedAt)
    await owner.write(control(`${label}-accepted`))
    chain.push(performance.now() - startedAt)
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  stops.forEach((stop) => stop())
  await new Promise((resolve) => setTimeout(resolve, 2000))
  await owner.close()
  const frames = []
  for (let index = 1; index < timings.length; index++) {
    const delta = timings[index].walFrames - timings[index - 1].walFrames
    if (delta > 0 && timings[index].walFrames !== timings[index - 1].walFrames) {
      frames.push(delta)
    }
  }
  const instrumented = timings.some((timing) => timing.op !== undefined)
  return {
    arm: arm.name,
    sha: arm.sha,
    sessions,
    turnItemMs: summary(probe),
    receiptMs: summary(chain),
    streamWriteMs: summary(streamWrites),
    writesPerSecond: Math.round(timings.length / seconds),
    ...(instrumented
      ? {
          writerWaitMs: summary(timings.map((timing) => timing.waitMs)),
          writerGateMsTotal: Math.round(
            timings.reduce(
              (total, timing) => total + (timing.batch ? timing.gateMs / timing.batch : 0),
              0
            )
          ),
          writerRunMs: summary(timings.map((timing) => timing.runMs)),
          writerDepth: summary(timings.map((timing) => timing.depth)),
          batchSize: summary(timings.map((timing) => timing.batch)),
          walFramesPerCommitGroup: summary(frames)
        }
      : {})
  }
}

const bundled = []
for (const [name, ref] of arms) {
  bundled.push(await bundleArm(name, ref))
}
await seed(bundled[0])
console.error(`database ${(statSync(filename).size / 2 ** 30).toFixed(1)} GiB`)
const load = Array.from({ length: cpuLoad }, () =>
  spawn(
    process.execPath,
    [join(root, 'tests/tools/benchmarks/cpu-pressure-worker.mjs'), '7200000'],
    { stdio: 'ignore' }
  )
)
const readers = startReaders(readerThreads)
const results = []
try {
  for (let round = 0; round < rounds; round++) {
    for (const sessions of sessionCounts) {
      for (const arm of round % 2 === 0 ? bundled : bundled.toReversed()) {
        const result = { round, ...(await run(arm, sessions)) }
        results.push(result)
        console.log(JSON.stringify(result))
      }
    }
  }
} finally {
  load.forEach((child) => child.kill('SIGKILL'))
  await Promise.all(readers.map((reader) => reader.terminate()))
}
if (args.out) {
  writeFileSync(
    args.out,
    JSON.stringify({ rows, seconds, cpuLoad, readerThreads, results }, null, 2)
  )
}
