import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './session-transcript-record-budget'
import type { SessionFileCandidate } from './session-scanner-types'

const SESSION_FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'
// One record past the budget, terminated separately so tests control the newline.
const OVERSIZED = Buffer.alloc(MAX_SESSION_TRANSCRIPT_RECORD_BYTES + 1, 'x')

let tempRoots: string[] = []

afterEach(async () => {
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

function record(text: string): string {
  return `${JSON.stringify({ type: 'user', sessionId: 's', message: { role: 'user', content: text } })}\n`
}

async function candidate(path: string): Promise<SessionFileCandidate> {
  const info = await stat(path)
  return {
    agent: 'claude',
    codexHome: null,
    file: {
      path,
      mtimeMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString(),
      sizeBytes: info.size
    }
  }
}

async function parse(path: string): Promise<string[]> {
  const session = await parseAgentSessionFileCached(await candidate(path), process.platform)
  return session?.previewMessages.map((message) => message.text) ?? []
}

function resumeOf(path: string) {
  return getSessionParseCacheEntry(path)?.resume
}

// Why: the resume cursor counts bytes, so a record dropped mid-file has to leave
// it on the byte after that record's newline. Off by one and every later
// incremental scan folds a half-line into the session.
it('keeps a byte-exact resume cursor across a skipped record', async () => {
  const root = await tempRoot('orca-record-budget-')
  const path = join(root, SESSION_FILE)
  const first = record('first')
  const second = record('second')
  const third = record('third')
  resetSessionParseCacheForTests()

  await writeFile(path, first)
  expect(await parse(path)).toEqual(['first'])
  expect(resumeOf(path)?.byteOffset).toBe(Buffer.byteLength(first))

  // An append that ends mid-oversized-record: the good record before it lands,
  // the cursor stays at the unterminated record's start because it may still grow.
  await appendFile(path, second)
  await appendFile(path, OVERSIZED)
  expect(await parse(path)).toEqual(['first', 'second'])
  expect(resumeOf(path)?.byteOffset).toBe(Buffer.byteLength(first + second))
  expect(resumeOf(path)?.skippedRecords).toEqual([
    { byteOffset: Buffer.byteLength(first + second), approximateBytes: OVERSIZED.length }
  ])

  // Terminate the oversized record and append a good one after it. Resuming
  // mid-line or one byte off would corrupt or duplicate a record here.
  await appendFile(path, `\n${third}`)
  expect(await parse(path)).toEqual(['first', 'second', 'third'])
  const size = (await stat(path)).size
  expect(resumeOf(path)?.byteOffset).toBe(size)
  expect(size).toBe(Buffer.byteLength(first + second + third) + OVERSIZED.length + 1)
  // Same start offset as the unterminated pass, so the merge replaces rather
  // than double-reports the record.
  expect(resumeOf(path)?.skippedRecords).toEqual([
    { byteOffset: Buffer.byteLength(first + second), approximateBytes: OVERSIZED.length }
  ])

  // One more append proves the cursor is still aligned after all of that.
  await appendFile(path, record('fourth'))
  expect(await parse(path)).toEqual(['first', 'second', 'third', 'fourth'])
  expect(resumeOf(path)?.byteOffset).toBe((await stat(path)).size)
})

it('folds a cold read around a mid-file oversized record', async () => {
  const root = await tempRoot('orca-record-budget-cold-')
  const path = join(root, SESSION_FILE)
  const first = record('first')
  const second = record('second')
  resetSessionParseCacheForTests()

  await writeFile(path, first)
  await appendFile(path, OVERSIZED)
  await appendFile(path, `\n${second}`)
  expect(await parse(path)).toEqual(['first', 'second'])
  expect(resumeOf(path)?.byteOffset).toBe((await stat(path)).size)
})

// Why: before this, the throw aborted the fold and the session vanished from
// the history list and from search entirely.
it('still lists a session with an oversized record and reports the loss', async () => {
  const root = await tempRoot('orca-record-budget-scan-')
  const roots = isolatedScanRoots(root)
  const dir = join(roots.claudeProjectsDir, 'project')
  const path = join(dir, SESSION_FILE)
  resetSessionParseCacheForTests()

  await mkdir(dir, { recursive: true })
  await writeFile(path, record('kept before'))
  await appendFile(path, OVERSIZED)
  await appendFile(path, `\n${record('kept after')}`)

  const result = await scanAiVaultSessions(roots)
  const session = result.sessions.find((entry) => entry.filePath === path)
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'kept before',
    'kept after'
  ])
  expect(result.issues).toEqual([
    {
      executionHostId: 'local',
      agent: 'claude',
      kind: 'notice',
      path,
      message: expect.stringContaining('Skipped 1 oversized transcript record')
    }
  ])
})
