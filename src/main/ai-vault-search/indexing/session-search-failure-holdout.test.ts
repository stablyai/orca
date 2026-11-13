import { appendFile, chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import type { SessionFileCandidate } from '../../ai-vault/session-scanner-types'
import {
  SESSION_SEARCH_FAILED_RETRY_BACKOFF_MS,
  SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT
} from './session-search-read-decision'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from '../storage/session-search-index-test-fixture'
import { SessionSearchStore } from '../storage/session-search-store'
import { recordTimestamp, sessionCandidate } from './session-search-transcript-fixtures'

// chmod cannot lock out read, and Windows ignores the mode bits.
const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0

const ANTE_SESSION_ID = '0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let root: string
let errors: unknown[]

beforeEach(async () => {
  resetTranscriptConsumersForTests()
  index = await openSessionSearchIndexFile('ss-held-out-sidecar')
  root = dirname(index.path)
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  store.close()
  await index.close()
})

it.skipIf(!CAN_DENY_READ)(
  'retries a held-out Ante session when its transcript grows past an unchanged meta.json',
  async () => {
    const directory = join(root, 'ante', 'sessions', ANTE_SESSION_ID)
    const metadataPath = join(directory, 'meta.json')
    const transcriptPath = join(directory, 'events.jsonl')
    await mkdir(directory, { recursive: true })
    await writeFile(
      metadataPath,
      JSON.stringify({ id: ANTE_SESSION_ID, dir: '/repo/app', first_user_message: 'ante' })
    )
    await writeFile(transcriptPath, anteEventLine('user', 'firstantemessage', 0))
    await runIndexPass([await anteCandidate(metadataPath, transcriptPath)])
    expect(matches('firstantemessage')).toEqual({ n: 1 })

    // A turn lands while the transcript turns unreadable, so every later read fails at one stat.
    await appendFile(transcriptPath, anteEventLine('assistant', 'secondantemessage', 1))
    await chmod(transcriptPath, 0o000)
    for (let attempt = 0; attempt < SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT; attempt++) {
      await runIndexPass([await anteCandidate(metadataPath, transcriptPath)])
    }
    const heldOut = store.files()[0]
    expect(heldOut.state).toBe('failed')
    expect(heldOut.failCount).toBe(SESSION_SEARCH_FAILURES_BEFORE_HELD_OUT)
    // Search keeps what the last committed read proved while the source stays unreadable.
    expect(matches('firstantemessage')).toEqual({ n: 1 })

    // Readable again at the very same stat: the backoff must keep holding this file out.
    await chmod(transcriptPath, 0o0644)
    await runIndexPass([await anteCandidate(metadataPath, transcriptPath)])
    expect(matches('secondantemessage')).toEqual({ n: 0 })

    // Nothing in either stat moved, so only the persisted failure clock can release the holdout.
    const failedAt = store.files()[0].failedAtMs
    expect(failedAt).toBeTypeOf('number')
    await runIndexPass(
      [await anteCandidate(metadataPath, transcriptPath)],
      (failedAt ?? 0) + SESSION_SEARCH_FAILED_RETRY_BACKOFF_MS + 1
    )
    expect(matches('secondantemessage')).toEqual({ n: 1 })
    expect(store.files()[0].state).toBe('current')

    // The metadata stat is frozen, so only the transcript can release the holdout.
    await appendFile(transcriptPath, anteEventLine('user', 'thirdantemessage', 2))
    await runIndexPass([await anteCandidate(metadataPath, transcriptPath)])
    expect(matches('secondantemessage')).toEqual({ n: 1 })
    expect(matches('thirdantemessage')).toEqual({ n: 1 })
    expect(store.files()[0].state).toBe('current')
  }
)

/** Run the search pass the indexer runs, so the read decision and failure stamp are as shipped. */
async function runIndexPass(candidates: SessionFileCandidate[], nowMs?: number): Promise<void> {
  await runSessionSearchIndexPass(store, candidates, {
    rows: new Map(store.files().map((fileRow) => [fileRow.path, fileRow])),
    nowMs
  })
  expect(errors).toEqual([])
}

function matches(term: string): unknown {
  return index.db
    .prepare(
      `SELECT count(*) AS n FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_row_id
       WHERE messages_fts MATCH ?`
    )
    .get(term)
}

/** Ante discovery hands the parser the transcript as a sidecar of `meta.json`. */
async function anteCandidate(
  metadataPath: string,
  transcriptPath: string
): Promise<SessionFileCandidate> {
  const candidate = await sessionCandidate('ante', metadataPath)
  const sidecar = await stat(transcriptPath)
  candidate.file.sidecar = {
    path: transcriptPath,
    mtimeMs: sidecar.mtimeMs,
    sizeBytes: sidecar.size
  }
  return candidate
}

/** One `events.jsonl` record in Ante's externally tagged `{ Variant: payload }` shape. */
function anteEventLine(role: 'user' | 'assistant', text: string, eventIndex: number): string {
  return `${JSON.stringify({
    timestamp: recordTimestamp(eventIndex),
    id: `evt_${eventIndex}`,
    event: role === 'user' ? { UserInput: text } : { AgentMessage: text }
  })}\n`
}
