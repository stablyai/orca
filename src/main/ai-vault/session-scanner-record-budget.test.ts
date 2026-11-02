import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import { aiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'
import { codexFixture, codexWorkerFixtureLines } from './session-scanner-codex-fixtures'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './session-transcript-record-budget'
import type { SessionFileCandidate } from './session-scanner-types'

const SESSION_FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'
const OMP_STEM = '2026-05-01T10-00-00-000Z_0199a000-0000-7000-8000-000000000002'
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

  // Keep the cursor at the growing oversized record while retaining earlier complete records.
  await appendFile(path, second)
  await appendFile(path, OVERSIZED)
  expect(await parse(path)).toEqual(['first', 'second'])
  expect(resumeOf(path)?.byteOffset).toBe(Buffer.byteLength(first + second))
  expect(resumeOf(path)?.skippedRecords).toEqual([
    { byteOffset: Buffer.byteLength(first + second), approximateBytes: OVERSIZED.length }
  ])

  // A misaligned resume cursor would corrupt or duplicate the first record after this skipped span.
  await appendFile(path, `\n${third}`)
  expect(await parse(path)).toEqual(['first', 'second', 'third'])
  const size = (await stat(path)).size
  expect(resumeOf(path)?.byteOffset).toBe(size)
  expect(size).toBe(Buffer.byteLength(first + second + third) + OVERSIZED.length + 1)
  // Match the earlier offset so the skip diagnostic replaces rather than duplicates the partial observation.
  expect(resumeOf(path)?.skippedRecords).toEqual([
    { byteOffset: Buffer.byteLength(first + second), approximateBytes: OVERSIZED.length }
  ])

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

it('lists a recovered session without an issue on fresh and cached scans', async () => {
  const root = await tempRoot('orca-record-budget-scan-')
  const roots = isolatedScanRoots(root)
  const fixture = codexFixture()
  const dir = roots.codexSessionsDir
  const path = join(dir, fixture.fileName)

  await mkdir(dir, { recursive: true })
  await writeFile(path, `${fixture.seedLines.join('\n')}\n`)
  await appendFile(path, '{"type":"compacted","payload":{"message":"')
  await appendFile(path, OVERSIZED)
  await appendFile(path, `"}}\n${fixture.appendLines.join('\n')}\n`)

  for (let scan = 0; scan < 2; scan++) {
    const result = await scanAiVaultSessions(roots)
    const session = result.sessions.find((entry) => entry.filePath === path)
    expect(session?.previewMessages.map((message) => message.text)).toEqual([
      'codex seed question',
      'codex seed answer',
      'codex follow-up',
      'codex incremental answer'
    ])
    expect(result.issues).toEqual([])
  }
})

it('reports skipped-only conversation content without treating an empty file as unreadable', async () => {
  const root = await tempRoot('orca-record-budget-unreadable-')
  const roots = isolatedScanRoots(root)
  const dir = join(roots.claudeProjectsDir, 'project')
  const path = join(dir, SESSION_FILE)
  const emptyPath = join(dir, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.jsonl')

  await mkdir(dir, { recursive: true })
  await writeFile(path, OVERSIZED)
  await appendFile(path, '\n')
  await writeFile(emptyPath, '')

  const result = await scanAiVaultSessions(roots)
  expect(result.sessions.find((entry) => entry.filePath === path)?.messageCount).toBe(0)
  expect(result.sessions.find((entry) => entry.filePath === emptyPath)?.messageCount).toBe(0)
  expect(result.issues).toEqual([
    {
      executionHostId: 'local',
      agent: 'claude',
      path,
      ...aiVaultScanIssueText('transcriptTooLarge', { params: { label: 'Claude' } })
    }
  ])
})

it('names the writer, not the discovery root, of a skipped-only OMP transcript under Pi', async () => {
  const root = await tempRoot('orca-record-budget-omp-')
  const roots = isolatedScanRoots(root)
  const path = join(roots.piSessionsDir, '-repo-app', `${OMP_STEM}.jsonl`)

  // Pi 0.84 / OMP 18.12 shapes (session-scanner-pi-omp-shared-root.test.ts): the title slot and runtime stamp mark OMP.
  await writeJsonlFile(path, [
    {
      type: 'title',
      v: 1,
      title: 'OMP named chat',
      source: 'user',
      updatedAt: '2026-05-01T10:00:02.000Z'
    },
    {
      type: 'session',
      version: 3,
      id: '0199a000-0000-7000-8000-000000000002',
      timestamp: '2026-05-01T10:00:00.000Z',
      cwd: '/repo/app'
    },
    {
      type: 'model_change',
      id: 'b1',
      parentId: null,
      timestamp: '2026-05-01T10:00:00.100Z',
      model: 'anthropic/claude-sonnet-4-5',
      runtime: { version: '18.12.2' }
    }
  ])
  await appendFile(
    path,
    `${JSON.stringify({
      type: 'message',
      id: 'b2',
      parentId: 'b1',
      timestamp: '2026-05-01T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: OVERSIZED.toString() }] }
    })}\n`
  )

  const result = await scanAiVaultSessions({ ...roots, platform: 'linux' })
  expect(result.sessions.find((entry) => entry.filePath === path)?.agent).toBe('omp')
  expect(result.issues).toEqual([
    {
      executionHostId: 'local',
      agent: 'pi',
      path,
      ...aiVaultScanIssueText('transcriptTooLarge', { params: { label: 'OMP' } })
    }
  ])
})

it('keeps a non-user Codex transcript out of the list and issues after a skipped record', async () => {
  const root = await tempRoot('orca-record-budget-worker-')
  const roots = isolatedScanRoots(root)
  const dir = roots.codexSessionsDir
  const path = join(dir, codexFixture().fileName)

  await mkdir(dir, { recursive: true })
  await writeFile(path, OVERSIZED)
  await appendFile(path, `\n${codexWorkerFixtureLines().join('\n')}\n`)

  const result = await scanAiVaultSessions(roots)
  expect(result.sessions.find((entry) => entry.filePath === path)).toBeUndefined()
  expect(result.issues).toEqual([])
})
