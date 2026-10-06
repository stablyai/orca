import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { isolatedScanRoots } from '../../src/main/ai-vault/session-scanner-test-fixtures'
import { resetSessionParseCacheForTests } from '../../src/main/ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../../src/main/ai-vault/session-transcript-consumers'
import { SessionSearchIndexer } from '../../src/main/ai-vault-search/session-search-indexer'
import { writeSyntheticTranscriptCorpus } from '../../src/main/ai-vault-search/session-search-synthetic-corpus'

// Bundle with esbuild --bundle --platform=node, then run on the host under test.
// What a warm pass costs on a machine with a real number of transcripts: a cycle
// stats the newest N per agent, a sweep stats every file under every root, and
// neither reads anything the index already holds at its current stat. This is the
// number the reconcile interval is chosen against; it does not set one.
// Never point this at a real transcript tree.

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
  // A flat corpus is not what discovery walks: spread it over project directories
  // so the readdir count is realistic rather than one enormous listing.
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
    // No wall-clock ceiling: the cold build has to finish before a warm pass can
    // be measured, and a deadline would leave a backlog priced into every number.
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
