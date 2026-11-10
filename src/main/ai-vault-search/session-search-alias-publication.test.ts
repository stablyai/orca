import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionSearchCandidateInventory } from './session-search-candidate-inventory'
import { SessionSearchIndexConsumer } from './session-search-index-consumer'
import { SessionSearchWorkQueue } from './session-search-work-queue'
import { SessionSearchEngine } from './session-search-engine'
import { SessionSearchStore } from './session-search-store'
import {
  openSessionSearchIndexFile,
  syntheticCandidate,
  syntheticSession,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let inventory: SessionSearchCandidateInventory
let engine: SessionSearchEngine
const first = candidate('opencode-first.db', 200)
const previous = candidate('opencode-previous.db', 100)
const latest = candidate('opencode-latest.db', 300)

function candidate(database: string, mtimeMs: number): SessionFileCandidate {
  return {
    ...syntheticCandidate({ path: `/archive/${database}#shared`, mtimeMs }),
    agent: 'opencode',
    file: { path: `/archive/${database}#shared`, mtimeMs, modifiedAt: '2025-01-01' }
  }
}
function discover(candidates: SessionFileCandidate[], rootDir = '/archive/storage') {
  return { agent: 'opencode' as const, rootDir, files: candidates.map((entry) => entry.file) }
}
function reader(
  input: SessionFileCandidate,
  owner: SessionSearchCandidateInventory | undefined = inventory
) {
  return new SessionSearchIndexConsumer(store, undefined, owner).beginRead({
    candidate: input,
    mode: 'replace',
    previousByteOffset: 0
  })
}
function finish(input: SessionFileCandidate, text: string, empty = false, owner = inventory) {
  const consumer = reader(input, owner)!
  consumer.message({ role: 'user', text, timestamp: null })
  consumer.finish({
    session: empty ? null : syntheticSession({ agent: 'opencode', filePath: input.file.path }),
    byteOffset: 100,
    incomplete: false
  })
}
async function settle(wake = false) {
  await inventory.beginPublications(wake)
  await inventory.reconcilePublications(store, () => false)
}
function hits(text: string) {
  return engine.search({ query: text }).hits.length
}

beforeEach(async () => {
  index = await openSessionSearchIndexFile('ss-alias-publication')
  store = new SessionSearchStore(index.path)
  inventory = new SessionSearchCandidateInventory(store)
  engine = new SessionSearchEngine(index.db)
})
afterEach(async () => {
  inventory.closePublications()
  vi.restoreAllMocks()
  store.close()
  await index.close()
})

it('keeps the published predecessor through deferred, incomplete and held-out replacement reads', async () => {
  await inventory.update([discover([previous])], new Set(), {})
  finish(previous, 'predecessorneedle')
  await inventory.update([discover([first])], new Set(), {})
  await settle()
  expect(hits('predecessorneedle')).toBe(1)
  reader(first)!.finish({ session: null, byteOffset: 0, incomplete: true })
  await settle()
  expect(hits('predecessorneedle')).toBe(1)
  store.setFileState(first.file.path, 'failed', first.file.mtimeMs)
  store.setFileState(first.file.path, 'failed', first.file.mtimeMs)
  await settle()
  expect(hits('predecessorneedle')).toBe(1)
  finish(first, 'replacementneedle')
  await settle()
  expect(hits('replacementneedle')).toBe(1)
  expect(hits('predecessorneedle')).toBe(0)
  expect(reader(previous)).toBeNull()
  // The suppressed raw member remains available for promotion after positive removal of its winner.
  await inventory.update([], new Set([first.file.path]), {})
  finish(previous, 'promotedneedle')
  expect(hits('promotedneedle')).toBe(1)
})

it('reconstructs cleanup from committed rows after restart and retries acknowledged withdrawal', async () => {
  // These committed rows model a crash after replacement publication but before predecessor cleanup.
  const detached = new SessionSearchCandidateInventory(store)
  finish(previous, 'predecessorneedle', false, detached)
  finish(first, 'replacementneedle', false, detached)
  await inventory.update([discover([first, previous])], new Set(), {})
  const remove = vi.spyOn(store, 'removeFile').mockReturnValue(false)
  for (let cycle = 0; cycle < 4; cycle++) {
    await settle()
  }
  expect(hits('predecessorneedle')).toBe(1)
  expect(inventory.pendingPublications).toBe(false)
  remove.mockRestore()
  await settle(true)
  expect(hits('replacementneedle')).toBe(1)
  expect(hits('predecessorneedle')).toBe(0)
  expect(reader(previous)).toBeNull()
})

it('fences stale search publication without blocking the foreground parser or removing the last good copy', async () => {
  await inventory.update([discover([previous])], new Set(), {})
  finish(previous, 'predecessorneedle')
  await inventory.update([discover([first])], new Set(), {})
  const stale = reader(first)!
  stale.message({ role: 'user', text: 'staleackneedle', timestamp: null })
  await inventory.update([discover([latest])], new Set(), {})
  stale.finish({ session: syntheticSession(), byteOffset: 100, incomplete: false })
  await settle()
  expect(hits('staleackneedle')).toBe(0)
  expect(hits('predecessorneedle')).toBe(1)
  finish(latest, 'currentwinnerneedle')
  await settle()
  expect(hits('predecessorneedle')).toBe(0)
  expect(hits('currentwinnerneedle')).toBe(1)
})

it('treats successful empty publication as authoritative', async () => {
  await inventory.update([discover([previous])], new Set(), {})
  finish(previous, 'predecessorneedle')
  await inventory.update([discover([first])], new Set(), {})
  finish(first, 'excludedneedle', true)
  await settle()
  expect(hits('predecessorneedle')).toBe(0)
  expect(hits('excludedneedle')).toBe(0)
})

it('settles cleanup when the selected transcript publishes again during removal acknowledgement', async () => {
  await inventory.update([discover([previous])], new Set(), {})
  finish(previous, 'predecessorneedle')
  await inventory.update([discover([first])], new Set(), {})
  finish(first, 'replacementneedle')
  const remove = store.removeFile.bind(store)
  vi.spyOn(store, 'removeFile').mockImplementationOnce((path) => {
    finish(first, 'refreshedwinnerneedle')
    return remove(path)
  })
  await settle()
  await settle()
  expect(hits('predecessorneedle')).toBe(0)
  expect(hits('refreshedwinnerneedle')).toBe(1)
})

it('protects a still-selected physical path before its other group attempts withdrawal', async () => {
  await inventory.update([discover([previous])], new Set(), {})
  finish(previous, 'sharedpathneedle')
  await inventory.update(
    [discover([first]), discover([previous], '/another/storage')],
    new Set(),
    {}
  )
  finish(first, 'replacementneedle')
  await settle()
  expect(hits('sharedpathneedle')).toBe(1)
  expect(hits('replacementneedle')).toBe(1)
})

it('transfers a deferred singleton forced read into later competitive publication ownership', async () => {
  await inventory.update([discover([first])], new Set(), {})
  finish(first, 'oldwinnerneedle')
  // Foreground reads of an alias not yet discovered are supported input.
  finish(previous, 'predecessorneedle', false, new SessionSearchCandidateInventory(store))
  const queue = new SessionSearchWorkQueue()
  await queue.enqueue(first, store, true)
  await inventory.requirePublication(first.file.path)
  // Its equal-stat forced read remains deferred when a new raw alias arrives next cycle.
  await inventory.update([discover([previous])], new Set(), {})
  await queue.enqueue(first, store)
  await inventory.beginPublications(false)
  await inventory.reconcilePublications(
    store,
    () => true,
    undefined,
    (candidate) => queue.hasPublicationDebt(candidate.file.path)
  )
  expect(hits('predecessorneedle')).toBe(1)
  finish(first, 'acceptedwinnerneedle')
  await queue.acknowledge((await queue.next())!, false)
  await settle()
  expect(hits('predecessorneedle')).toBe(0)
  expect(hits('acceptedwinnerneedle')).toBe(1)
})
