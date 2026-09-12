#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Pass a directory containing journal-open.ts and journal-row-table.ts from the base commit.
const baselineDir = process.argv[2]
assert.ok(
  baselineDir,
  'Usage: node --expose-gc journal-replay-retention-benchmark.mjs BASELINE_DIR'
)
assert.ok(global.gc, 'Run with --expose-gc to measure live backing memory during replay')
const root = fileURLToPath(new URL('../..', import.meta.url))
const fixture = await mkdtemp(join(tmpdir(), 'orca-journal-replay-bench-'))
try {
  const implementations = {}
  for (const arm of ['baseline', 'current']) {
    const outfile = join(fixture, `${arm}.cjs`)
    await build({
      stdin: {
        contents:
          "export {openAgentSessionJournal} from './src/main/native-chat/agent-session-journal/journal-store-factory'; export {loadJournal} from './src/main/native-chat/agent-session-journal/journal-open'; export {journalDatabaseFile} from './src/main/native-chat/agent-session-journal/journal-paths';",
        resolveDir: root
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      plugins: [
        {
          name: 'replay-memory-probe',
          setup(plugin) {
            plugin.onLoad(
              { filter: /journal-(?:open|row-table|reducer)\.ts$/ },
              async ({ path }) => {
                const leaf = basename(path)
                let source = await readFile(
                  arm === 'baseline' && leaf !== 'journal-reducer.ts'
                    ? join(baselineDir, leaf)
                    : path,
                  'utf8'
                )
                if (leaf === 'journal-reducer.ts') {
                  const marker =
                    'export function applyJournalRow(state: JournalReducerState, row: JournalRow): void {'
                  assert.ok(source.includes(marker))
                  source = source.replace(
                    marker,
                    `${marker}\nglobalThis.__replayMemoryProbe?.(row.seq);`
                  )
                }
                return { contents: source, loader: 'ts', resolveDir: dirname(path) }
              }
            )
          }
        }
      ]
    })
    implementations[arm] = createRequire(import.meta.url)(outfile)
  }
  const identity = {
    sessionId: 'benchmark',
    workspaceId: 'fixture',
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: 'thread' }
  }
  const journalDir = join(fixture, 'session')
  const journal = await implementations.current.openAgentSessionJournal({ identity, journalDir })
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
  await journal.close()
  for (const arm of ['baseline', 'current', 'current', 'baseline']) {
    global.gc()
    const start = performance.now()
    let loaded = implementations[arm].loadJournal(journalDir, identity.sessionId)
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
    loaded = implementations[arm].loadJournal(journalDir, identity.sessionId)
    delete globalThis.__replayMemoryProbe
    assert.equal(loaded.state.items.size, 1)
    loaded = null
    console.log(
      JSON.stringify({
        arm,
        ms,
        databaseBytes: (await stat(implementations[arm].journalDatabaseFile(journalDir))).size,
        peakLiveHeapDelta: peakLiveHeap - initialHeap
      })
    )
  }
} finally {
  delete globalThis.__replayMemoryProbe
  await rm(fixture, { recursive: true, force: true })
}
