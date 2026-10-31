import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { isolatedScanRoots } from '../../src/main/ai-vault/session-scanner-test-fixtures'
import { resetSessionParseCacheForTests } from '../../src/main/ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../../src/main/ai-vault/session-transcript-consumers'
import { SessionSearchIndexer } from '../../src/main/ai-vault-search/session-search-indexer'
import { writeSyntheticTranscriptCorpus } from '../../src/main/ai-vault-search/session-search-synthetic-corpus'

// Bundle with esbuild --bundle --platform=node and run on target host over synthetic corpus only; never use real transcripts.
// Price warm stat-only cycle/sweep used to choose reconcile interval, without setting it or reading already-current content.

const SESSIONS = 5_000
const TURNS_PER_SESSION = 4
const PROJECTS = 40

const corpus = await writeSyntheticTranscriptCorpus({
  sessions: SESSIONS,
  turnsPerSession: TURNS_PER_SESSION
})
const root = await mkdtemp(join(tmpdir(), 'orca-search-pass-'))
const roots = isolatedScanRoots(root)
const databasePath = join(root, 'index', 'session-search.sqlite')

try {
  // Spread synthetic corpus over project dirs to model discovery’s readdir cost instead of one flat listing.
  for (let index = 0; index < PROJECTS; index++) {
    await mkdir(join(roots.claudeProjectsDir, `project-${index}`), { recursive: true })
  }
  await Promise.all(
    corpus.files.map((path, index) =>
      rename(path, join(roots.claudeProjectsDir, `project-${index % PROJECTS}`, basename(path)))
    )
  )

  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  const errors: unknown[] = []
  const indexer = new SessionSearchIndexer({
    databasePath,
    roots,
    historyDays: null,
    // Finish cold indexing before warm measurement; deadline would contaminate timings with backlog.
    passDeadlineMs: Number.MAX_SAFE_INTEGER,
    onError: (error) => errors.push(error)
  })
  try {
    const coldStarted = performance.now()
    await indexer.start()
    const coldMs = performance.now() - coldStarted
    assert.deepEqual(errors, [])
    assert.equal(indexer.status().filesIndexed, SESSIONS, 'indexed file count')

    const sweepStarted = performance.now()
    await indexer.reconcile({ full: true })
    const sweepMs = performance.now() - sweepStarted

    const cycleStarted = performance.now()
    await indexer.reconcile({ full: false })
    const cycleMs = performance.now() - cycleStarted

    assert.deepEqual(errors, [])
    assert.equal(indexer.status().filesDue, 0, 'nothing owed after a warm sweep')
    console.log(
      JSON.stringify(
        {
          transcripts: SESSIONS,
          projectDirectories: PROJECTS,
          transcriptMb: Math.round((corpus.transcriptBytes / (1024 * 1024)) * 100) / 100,
          coldBuildMs: Math.round(coldMs),
          warmSweepMs: Math.round(sweepMs),
          warmCycleMs: Math.round(cycleMs)
        },
        null,
        2
      )
    )
  } finally {
    indexer.close()
    resetTranscriptConsumersForTests()
    resetSessionParseCacheForTests()
  }
} finally {
  await rm(corpus.root, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
}
