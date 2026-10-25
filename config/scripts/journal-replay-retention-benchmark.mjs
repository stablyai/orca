#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Pass the root of a checkout (or `git archive <base> src` extract) of the base commit: each arm is
// bundled whole from its own tree and writes its own fixture, since the two store history differently.
const baselineDir = process.argv[2]
assert.ok(
  baselineDir,
  'Usage: node --expose-gc journal-replay-retention-benchmark.mjs BASELINE_CHECKOUT_ROOT'
)
assert.ok(global.gc, 'Run with --expose-gc to measure live backing memory during replay')
const root = fileURLToPath(new URL('../..', import.meta.url))
const journalSource = './src/main/native-chat/agent-session-journal'
const entries = {
  baseline: `export {openAgentSessionJournal} from '${journalSource}/journal-store-factory'; export {replayJournal} from '${journalSource}/journal-open'; export {openJournalDatabase} from '${journalSource}/journal-database'; export {journalDatabaseFile} from '${journalSource}/journal-paths';`,
  current: `export {openAgentSessionJournal} from '${journalSource}/journal-store-factory'; export {replayJournal} from '${journalSource}/journal-open'; export {JournalHostDatabase, journalDatabasePath} from '${journalSource}/journal-host-database';`
}
const sourceRoots = { baseline: resolve(baselineDir), current: root }
const identity = {
  sessionId: 'benchmark',
  workspaceId: 'fixture',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { transport: 'codex-app-server', agent: 'codex', nativeId: 'thread' }
}
// The baseline predates the neutral handle and takes its journal identity in the typed form.
const baselineIdentity = { ...identity, providerHandle: { kind: 'codex', threadId: 'thread' } }
const fixture = await mkdtemp(join(tmpdir(), 'orca-journal-replay-bench-'))
// Released in `finally`, newest first: an open SQLite handle blocks the fixture's removal on Windows.
const releases = []

async function bundle(arm) {
  const outfile = join(fixture, `${arm}.cjs`)
  await build({
    stdin: { contents: entries[arm], resolveDir: sourceRoots[arm] },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    // A bare base checkout has no node_modules of its own.
    nodePaths: [join(root, 'node_modules')],
    plugins: [
      {
        name: 'replay-memory-probe',
        setup(plugin) {
          plugin.onLoad({ filter: /journal-reducer\.ts$/ }, async ({ path }) => {
            const marker =
              'export function applyJournalRow(state: JournalReducerState, row: JournalRow): void {'
            const source = await readFile(path, 'utf8')
            assert.ok(source.includes(marker), `${basename(path)} lost the probe marker`)
            return {
              contents: source.replace(
                marker,
                `${marker}\nglobalThis.__replayMemoryProbe?.(row.seq);`
              ),
              loader: 'ts',
              resolveDir: dirname(path)
            }
          })
        }
      }
    ]
  })
  return createRequire(import.meta.url)(outfile)
}

/** One long-revised item, written by the arm's own store; returns the arm's replay of it. */
async function openArm(arm) {
  const implementation = await bundle(arm)
  const stateDirectory = join(fixture, arm)
  let journal
  let database
  if (arm === 'baseline') {
    journal = await implementation.openAgentSessionJournal({
      identity: baselineIdentity,
      journalDir: stateDirectory
    })
  } else {
    database = implementation.JournalHostDatabase.open(stateDirectory)
    releases.push(() => database.close())
    journal = await implementation.openAgentSessionJournal({ identity, database })
  }
  releases.push(() => journal.close())
  const item = { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 }
  const text = 'x'.repeat(32768)
  for (let revision = 0; revision < 2000; revision++) {
    await journal.appendItem(
      item,
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `${text}${revision}` }]
      },
      { fence: 1 }
    )
  }
  await releases.pop()()
  if (arm === 'current') {
    return {
      path: implementation.journalDatabasePath(stateDirectory),
      replay: () => implementation.replayJournal(database.db, identity.sessionId)
    }
  }
  const path = implementation.journalDatabaseFile(stateDirectory)
  const opened = implementation.openJournalDatabase(path)
  releases.push(() => opened.db.close())
  return {
    path,
    // The base replay takes the connection's read-only flag before the chat.
    replay: () => implementation.replayJournal(opened.db, opened.readOnly, identity.sessionId)
  }
}

try {
  const arms = { baseline: await openArm('baseline'), current: await openArm('current') }
  for (const arm of ['baseline', 'current', 'current', 'baseline']) {
    global.gc()
    const start = performance.now()
    let loaded = arms[arm].replay()
    const ms = performance.now() - start
    assert.equal(loaded.state.items.size, 1)
    assert.equal([...loaded.state.items.values()][0].revision, 2000)
    loaded = null
    global.gc()
    const initialHeap = process.memoryUsage().heapUsed
    let peakLiveHeap = initialHeap
    globalThis.__replayMemoryProbe = (sequence) => {
      if (sequence !== 1 && sequence % 256 !== 0) {
        return
      }
      global.gc()
      peakLiveHeap = Math.max(peakLiveHeap, process.memoryUsage().heapUsed)
    }
    loaded = arms[arm].replay()
    delete globalThis.__replayMemoryProbe
    assert.equal(loaded.state.items.size, 1)
    loaded = null
    console.log(
      JSON.stringify({
        arm,
        ms,
        databaseBytes: (await stat(arms[arm].path)).size,
        peakLiveHeapDelta: peakLiveHeap - initialHeap
      })
    )
  }
} finally {
  delete globalThis.__replayMemoryProbe
  for (const release of releases.toReversed()) {
    try {
      await release()
    } catch (error) {
      console.error('[journal-replay-retention-benchmark] release failed', error)
    }
  }
  await rm(fixture, { recursive: true, force: true })
}
