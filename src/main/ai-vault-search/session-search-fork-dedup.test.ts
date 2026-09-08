import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import { SessionSearchStore } from './session-search-store'
import { assistantRecord, parseTranscript, userRecord } from './session-search-transcript-fixtures'

const PARENT_ID = 'aaaaaaaa-0000-4000-8000-00000000000a'
const FORK_ID = 'aaaaaaaa-0000-4000-8000-00000000000b'

let tempRoots: string[] = []
let store: SessionSearchStore

beforeEach(async () => {
  resetSessionParseCacheForTests()
  const root = await makeTempDir()
  store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
    throw error
  })
  registerSessionSearchIndexSink(store)
})

afterEach(async () => {
  registerSessionSearchIndexSink(null)
  store.close()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-fork-'))
  tempRoots.push(root)
  return root
}

/** Eight-message opening prefix, byte-identical apart from the session id. */
function prefixLines(
  sessionId: string,
  firstPrompt = 'the reconnect backoff never fires'
): string[] {
  const lines = [userRecord(0, firstPrompt, sessionId)]
  for (let index = 1; index < 8; index += 1) {
    const text = `shared prefix turn ${index} about the reconnect ladder`
    lines.push(
      index % 2 === 0 ? userRecord(index, text, sessionId) : assistantRecord(index, text, sessionId)
    )
  }
  return lines
}

async function writeTranscript(root: string, sessionId: string, lines: string[]): Promise<string> {
  const path = join(root, `${sessionId}.jsonl`)
  await writeFile(path, `${lines.join('\n')}\n`)
  await parseTranscript(path)
  return path
}

describe('forked session dedup', () => {
  it('collapses two transcripts that share their first eight messages', async () => {
    const root = await makeTempDir()
    await writeTranscript(root, PARENT_ID, [
      ...prefixLines(PARENT_ID),
      assistantRecord(9, 'parent tail talks about zeta', PARENT_ID)
    ])
    await writeTranscript(root, FORK_ID, [
      ...prefixLines(FORK_ID),
      assistantRecord(40, 'fork tail talks about omega', FORK_ID)
    ])

    const result = store.search({ query: 'reconnect ladder' })
    expect(result.hits).toHaveLength(1)
    // Newest `updated_at` wins the collapse; both copies are still counted.
    expect(result.hits[0]).toMatchObject({ sessionId: FORK_ID, duplicateCount: 2 })
    // Both files stay indexed as rows; only the roll-up collapses.
    expect(store.coverage().sessionsIndexed).toBe(2)
    // A term unique to the collapsed copy still finds it (as its own hit).
    expect(store.search({ query: 'zeta' }).hits.map((hit) => hit.sessionId)).toEqual([PARENT_ID])
  })

  it('keeps sessions that differ inside the first eight messages apart', async () => {
    const root = await makeTempDir()
    await writeTranscript(root, PARENT_ID, prefixLines(PARENT_ID))
    await writeTranscript(
      root,
      FORK_ID,
      prefixLines(FORK_ID, 'the reconnect backoff fires far too often')
    )

    const result = store.search({ query: 'reconnect ladder' })
    expect(result.hits).toHaveLength(2)
    expect(result.hits.every((hit) => hit.duplicateCount === undefined)).toBe(true)
  })

  it('leaves the hash alone when the winner grows by an append', async () => {
    const root = await makeTempDir()
    await writeTranscript(root, PARENT_ID, [
      ...prefixLines(PARENT_ID),
      assistantRecord(9, 'parent tail talks about zeta', PARENT_ID)
    ])
    const forkPath = await writeTranscript(root, FORK_ID, [
      ...prefixLines(FORK_ID),
      assistantRecord(40, 'fork tail talks about omega', FORK_ID)
    ])

    await appendFile(forkPath, `${userRecord(50, 'kappa follow-up question', FORK_ID)}\n`)
    const { stats } = await parseTranscript(forkPath)
    expect(stats.incremental).toBe(1)

    // Frozen prefix hash: the append must not break the collapse.
    const result = store.search({ query: 'reconnect ladder' })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({ sessionId: FORK_ID, duplicateCount: 2 })
    expect(store.search({ query: 'kappa' }).hits).toHaveLength(1)
  })
})
