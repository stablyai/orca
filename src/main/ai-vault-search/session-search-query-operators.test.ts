import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import { SessionSearchStore } from './session-search-store'
import { parseTranscript, userRecord } from './session-search-transcript-fixtures'

const APP_ID = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SERVICE_ID = 'aaaaaaaa-0000-4000-8000-00000000000b'
const NEWER_APP_ID = 'aaaaaaaa-0000-4000-8000-00000000000c'

let tempRoots: string[] = []
let root: string
let store: SessionSearchStore

async function makeTempDir(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'orca-session-search-operators-'))
  tempRoots.push(created)
  return created
}

async function indexSession(sessionId: string, cwd: string, text: string, at = 0): Promise<void> {
  const path = join(root, `${sessionId}.jsonl`)
  await writeFile(path, `${userRecord(at, text, sessionId, cwd)}\n`)
  await parseTranscript(path)
}

function sessionIds(query: string, args: Record<string, unknown> = {}): string[] {
  return store.search({ query, ...args }).hits.map((hit) => hit.sessionId)
}

beforeEach(async () => {
  resetSessionParseCacheForTests()
  root = await makeTempDir()
  store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
    throw error
  })
  registerSessionSearchIndexSink(store)
  await indexSession(APP_ID, '/repo/app', 'harbor pilot manifest alpha')
  await indexSession(SERVICE_ID, '/other/service', 'harbor pilot manifest beta')
  await indexSession(NEWER_APP_ID, '/repo/app', 'harbor dock crane', 500)
})

afterEach(async () => {
  registerSessionSearchIndexSink(null)
  store.close()
  await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })))
  tempRoots = []
})

describe('repo: and path: operators at the query level', () => {
  it('scopes repo: to the last segment of cwd', () => {
    expect(sessionIds('harbor repo:app').sort()).toEqual([APP_ID, NEWER_APP_ID].sort())
    expect(sessionIds('harbor repo:service')).toEqual([SERVICE_ID])
    // `/other` is a parent directory, never the repo folder itself.
    expect(sessionIds('harbor repo:other')).toEqual([])
  })

  it('treats an absolute path: term as a cwd scope and a relative one as a fragment', () => {
    expect(sessionIds('harbor path:/repo').sort()).toEqual([APP_ID, NEWER_APP_ID].sort())
    expect(sessionIds('harbor path:/other')).toEqual([SERVICE_ID])
    expect(sessionIds('harbor path:/repo/app').sort()).toEqual([APP_ID, NEWER_APP_ID].sort())
    expect(sessionIds('harbor path:app').sort()).toEqual([APP_ID, NEWER_APP_ID].sort())
    expect(sessionIds('harbor path:service')).toEqual([SERVICE_ID])
  })

  it('answers an operator-only query with the newest matching sessions', () => {
    const result = store.search({ query: 'repo:app' })
    expect(result.route).toBe('or')
    expect(result.hits.map((hit) => hit.sessionId)).toEqual([NEWER_APP_ID, APP_ID])
    expect(result.hits[0]?.evidence).toEqual({ role: 'unknown', timestamp: null, snippet: '' })
    expect(store.search({ query: 'repo:app', limit: 1 }).hits.map((hit) => hit.sessionId)).toEqual([
      NEWER_APP_ID
    ])
    // A query with neither text nor operators still returns nothing.
    expect(store.search({ query: '   ' }).hits).toEqual([])
  })

  it('still requires the free text to match when operators are present', () => {
    expect(sessionIds('crane repo:app')).toEqual([NEWER_APP_ID])
    expect(sessionIds('crane repo:service')).toEqual([])
    expect(sessionIds('beta repo:app')).toEqual([])
    expect(store.search({ query: 'crane repo:app' }).hits[0]?.evidence.snippet).toContain('[crane]')
  })

  it('narrows explicit scopePaths instead of widening them', () => {
    expect(sessionIds('harbor', { scopePaths: ['/repo'] }).sort()).toEqual(
      [APP_ID, NEWER_APP_ID].sort()
    )
    expect(sessionIds('harbor repo:service', { scopePaths: ['/repo'] })).toEqual([])
    expect(sessionIds('repo:service', { scopePaths: ['/repo'] })).toEqual([])
  })

  it('keeps operator text out of the FTS expression', () => {
    // `harbo` is one edit from the indexed `harbor`: if the operator value
    // reached the planner it would come back on a typo+ route.
    const result = store.search({ query: 'repo:harbo' })
    expect(result.hits).toEqual([])
    expect(result.route).toBe('or')
    expect(result.repairedTerms).toBeUndefined()
    expect(store.search({ query: 'path:manifest' }).hits).toEqual([])
  })
})
