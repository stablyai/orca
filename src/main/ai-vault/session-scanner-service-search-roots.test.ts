import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  openSessionSearchIndexerHarness,
  writeMessageGraphTranscript,
  type SessionSearchIndexerHarness
} from '../ai-vault-search/session-search-indexer-test-fixture'
import { SessionSearchIndexer } from '../ai-vault-search/session-search-indexer'
import type { SessionSearchScanRoots } from '../ai-vault-search/session-search-scan-roots'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import type { AiVaultSessionSearchInit } from './session-scanner-service-protocol'
import { SessionScannerServiceSearch } from './session-scanner-service-search'
import { resetTranscriptConsumersForTests } from './session-transcript-consumers'

let harness: SessionSearchIndexerHarness
let subject: SessionScannerServiceSearch
let spawnRoot: string
let lateRoot: string
let currentRoots: SessionSearchScanRoots
let spawnRoots: SessionSearchScanRoots

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('ss-service-roots')
  subject = new SessionScannerServiceSearch(async () => currentRoots)
  const { openclawLegacyStateDir, ...rest } = harness.roots
  spawnRoot = harness.roots.openclawStateDir ?? ''
  lateRoot = openclawLegacyStateDir ?? ''
  spawnRoots = rest
  currentRoots = rest
})

afterEach(async () => {
  subject.close()
  vi.restoreAllMocks()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function init(roots: SessionSearchScanRoots): AiVaultSessionSearchInit {
  return {
    databasePath: harness.databasePath,
    settings: { enabled: true, historyDays: null },
    roots
  }
}

/** OpenClaw reads `<stateDir>/agents/**` and keeps only paths through `sessions`. */
function openclawTranscript(stateDir: string, name: string): string {
  return join(stateDir, 'agents', 'main', 'sessions', `${name}.jsonl`)
}

async function sessionsMatching(term: string): Promise<string[]> {
  const reply = await subject.execute({
    type: 'request',
    id: 1,
    operation: 'searchSessions',
    request: { query: term }
  })
  if (reply.operation !== 'searchSessions' || reply.value.kind !== 'results') {
    throw new Error(`expected results, got ${JSON.stringify(reply)}`)
  }
  return reply.value.hits.map((hit) => hit.sessionId).sort()
}

async function indexedSessions(term: string, expected: string[]): Promise<void> {
  await vi.waitFor(
    async () => {
      await subject.execute({ type: 'request', id: 2, operation: 'searchReconcile' })
      expect(await sessionsMatching(term)).toEqual(expected)
    },
    { timeout: 20_000 }
  )
}

it('refreshes a late root without rebuilding the index', async () => {
  await writeMessageGraphTranscript(openclawTranscript(spawnRoot, 'early-session'), [
    'a conversation in a root the spawn already knew'
  ])
  await writeMessageGraphTranscript(openclawTranscript(lateRoot, 'late-session'), [
    'a conversation in a distro that started later'
  ])

  subject.apply(init(spawnRoots))
  await indexedSessions('conversation', ['early-session'])

  const close = vi.spyOn(SessionSearchIndexer.prototype, 'close')
  currentRoots = harness.roots
  await indexedSessions('conversation', ['early-session', 'late-session'])
  expect(close).not.toHaveBeenCalled()
})

it('keeps the live indexer when an unchanged root snapshot is refreshed', async () => {
  await writeMessageGraphTranscript(openclawTranscript(spawnRoot, 'early-session'), [
    'a conversation in a root the spawn already knew'
  ])
  subject.apply(init(harness.roots))
  await indexedSessions('conversation', ['early-session'])

  const close = vi.spyOn(SessionSearchIndexer.prototype, 'close')
  currentRoots = { ...spawnRoots }
  await indexedSessions('conversation', ['early-session'])
  expect(close).not.toHaveBeenCalled()
})
