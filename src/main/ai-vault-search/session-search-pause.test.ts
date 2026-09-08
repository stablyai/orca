import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionSearchService } from './session-search-service'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { getSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import {
  userRecord,
  parseTranscript,
  CLAUDE_SESSION_ID
} from './session-search-transcript-fixtures'

vi.mock('./session-search-backfill-pacing', () => ({
  pauseBackfill: () => new Promise<void>((resolve) => setImmediate(resolve))
}))

let root: string
let service: SessionSearchService
let roots: ReturnType<typeof isolatedScanRoots>
let file: string
let databasePath: string
const enabled = { enabled: true, historyDays: null }

beforeEach(async () => {
  resetSessionParseCacheForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-indexing-pause-'))
  roots = isolatedScanRoots(root)
  databasePath = join(root, 'index.sqlite')
  const dir = join(roots.claudeProjectsDir, 'project')
  await mkdir(dir, { recursive: true })
  file = join(dir, `${CLAUDE_SESSION_ID}.jsonl`)
  await writeFile(file, `${userRecord(0, 'originalneedle')}\n`)
  service = new SessionSearchService({ databasePath, ...enabled })
})

afterEach(async () => {
  await service.close()
  await rm(root, { recursive: true, force: true })
})

it('pauses ordinary scanner writes and query refreshes, then catches up without losing prior data', async () => {
  await service.ensureBackfill(roots)
  const completed = service.coverage()
  expect(completed.indexing).toMatchObject({
    phase: 'complete',
    filesProcessed: 1,
    filesTotal: 1,
    failures: 0
  })
  await service.configure({ ...enabled, paused: true }, roots)
  expect(service.coverage().indexing).toMatchObject({ ...completed.indexing, phase: 'paused' })
  await appendFile(file, `${userRecord(1, 'appendedneedle')}\n`)
  await parseTranscript(file)
  expect((await service.search({ query: 'originalneedle' }, roots)).hits).toHaveLength(1)
  expect((await service.search({ query: 'appendedneedle' }, roots)).hits).toHaveLength(0)
  expect(service.coverage().messagesIndexed).toBe(completed.messagesIndexed)
  await service.configure(enabled, roots)
  await service.ensureBackfill(roots)
  expect((await service.search({ query: 'appendedneedle' }, roots)).hits).toHaveLength(1)
  expect(service.coverage().indexing?.phase).toBe('complete')
})

it('keeps pause across a scanner restart and preserves saved results', async () => {
  await service.ensureBackfill(roots)
  await service.configure({ ...enabled, paused: true }, roots)
  await service.close()
  service = new SessionSearchService({ databasePath, ...enabled, paused: true })
  await appendFile(file, `${userRecord(1, 'restartneedle')}\n`)
  await service.ensureBackfill(roots)
  expect(service.coverage().indexing?.phase).toBe('paused')
  expect((await service.search({ query: 'originalneedle' }, roots)).hits).toHaveLength(1)
  expect((await service.search({ query: 'restartneedle' }, roots)).hits).toHaveLength(0)
  await service.configure(enabled, roots)
  await service.ensureBackfill(roots)
  expect((await service.search({ query: 'restartneedle' }, roots)).hits).toHaveLength(1)
})

it('clear while paused stays paused; disabling closes the sink and retains the preference', async () => {
  await service.ensureBackfill(roots)
  await service.configure({ ...enabled, paused: true }, roots, { clearIndex: true })
  expect(service.coverage()).toMatchObject({ sessionsIndexed: 0, indexing: { phase: 'paused' } })
  await service.ensureBackfill(roots)
  expect(service.coverage().sessionsIndexed).toBe(0)
  await service.configure({ ...enabled, enabled: false, paused: true }, roots)
  expect(getSessionSearchIndexSink()).toBeNull()
  await service.configure({ ...enabled, paused: true }, roots)
  expect(service.coverage().indexing?.phase).toBe('paused')
  await service.configure(enabled, roots)
  await service.ensureBackfill(roots)
  expect(service.coverage().sessionsIndexed).toBe(1)
})

it('an interrupted write cannot be revived by a quick resume', async () => {
  const { SessionSearchStore } = await import('./session-search-store')
  const { stagedWriteUpdate } = await import('./session-search-staged-write-test-fixture')
  const store = getSessionSearchIndexSink() as InstanceType<typeof SessionSearchStore>
  await store.apply(stagedWriteUpdate('savedneedle', 1))
  let entered!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const update = stagedWriteUpdate('cancelledneedle', 200)
  update.messages = (async function* () {
    for (let i = 0; i < 200; i++) {
      if (i === 130) {
        entered()
        await held
      }
      yield { role: 'user' as const, text: 'cancelledneedle', timestamp: null }
    }
  })()
  const writing = store.apply(update)
  await reached
  store.setAcceptingWrites(false)
  store.setAcceptingWrites(true)
  release()
  await writing
  expect(store.search({ query: 'savedneedle' }).hits).toHaveLength(1)
  expect(store.search({ query: 'cancelledneedle' }).hits).toHaveLength(0)
})

it('pauses a running initial pass after a completed file and resumes the unfinished file', async () => {
  const { SessionSearchStore } = await import('./session-search-store')
  const store = getSessionSearchIndexSink() as InstanceType<typeof SessionSearchStore>
  const secondFile = join(roots.claudeProjectsDir, 'project', 'second.jsonl')
  await writeFile(
    secondFile,
    `${userRecord(0, 'secondneedle').replaceAll(CLAUDE_SESSION_ID, 'second-session')}\n`
  )
  let entered!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const apply = store.apply.bind(store)
  let files = 0
  vi.spyOn(store, 'apply').mockImplementation(async (update) => {
    files++
    if (files === 2) {
      entered()
      await held
    }
    return apply(update)
  })
  const backfill = service.ensureBackfill(roots)
  await reached
  expect(service.coverage().indexing).toMatchObject({
    phase: 'indexing',
    filesProcessed: 1,
    filesTotal: 2
  })
  const pausing = service.configure({ ...enabled, paused: true }, roots)
  release()
  await pausing
  await backfill
  expect(service.coverage()).toMatchObject({
    sessionsIndexed: 1,
    indexing: { phase: 'paused', filesProcessed: 1, filesTotal: 2 }
  })
  await service.configure(enabled, roots)
  await service.ensureBackfill(roots)
  expect(service.coverage()).toMatchObject({
    sessionsIndexed: 2,
    indexing: { phase: 'complete', filesProcessed: 2, filesTotal: 2 }
  })
})
