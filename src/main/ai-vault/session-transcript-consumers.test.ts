import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'
import { readWholeTranscript } from './session-transcript-reader'

const OPENCODE_SQLITE_SESSION = {
  id: 'local:opencode:sqlite-session:db',
  agent: 'opencode' as const,
  sessionId: 'sqlite-session'
}

// Stands in for the worker thread: the point is that its messages never come
// back over the channel, not what the SQLite read returns.
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof OpenCodeSqliteWorkerSpawn>()),
  parseOpenCodeSqliteSessionViaWorker: () => Promise.resolve(OPENCODE_SQLITE_SESSION)
}))
import type * as OpenCodeSqliteWorkerSpawn from './session-scanner-opencode-sqlite-worker-spawn'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptMessage,
  type TranscriptReadOutcome,
  type TranscriptReadStart
} from './session-transcript-consumers'

type RecordedRead = {
  start: TranscriptReadStart
  messages: TranscriptMessage[]
  outcome: TranscriptReadOutcome | null
}

function recordingConsumer(): { reads: RecordedRead[]; unregister: () => void } {
  const reads: RecordedRead[] = []
  const unregister = registerTranscriptConsumer({
    beginRead: (start) => {
      const read: RecordedRead = { start, messages: [], outcome: null }
      reads.push(read)
      return {
        message: (message) => read.messages.push(message),
        finish: (outcome) => {
          read.outcome = outcome
        }
      }
    }
  })
  return { reads, unregister }
}

function textsFor(reads: RecordedRead[], agent: string): string[] {
  return reads
    .filter((read) => read.start.candidate.agent === agent)
    .flatMap((read) => read.messages.map((message) => `${message.role}:${message.text}`))
}

let tempRoots: string[] = []

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function claudeTurns(from: number, to: number): unknown[] {
  const records: unknown[] = []
  for (let index = from; index <= to; index++) {
    records.push({
      type: 'user',
      sessionId: 'claude-session',
      timestamp: `2026-05-01T10:0${index}:00.000Z`,
      cwd: '/tmp/claude',
      message: { role: 'user', content: `ask ${index}` }
    })
    records.push({
      type: 'assistant',
      sessionId: 'claude-session',
      timestamp: `2026-05-01T10:0${index}:01.000Z`,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `reply ${index}` },
          { type: 'tool_use', name: 'Bash', input: { command: `ls ${index}` } }
        ]
      }
    })
  }
  return records
}

async function writeClaudeFixture(): Promise<{
  root: string
  roots: ReturnType<typeof isolatedScanRoots>
  transcript: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-consumers-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const transcript = join(roots.claudeProjectsDir, 'project', 'claude-session.jsonl')
  await mkdir(join(roots.claudeProjectsDir, 'project'), { recursive: true })
  await writeFile(transcript, `${jsonLines(claudeTurns(1, 4))}\n`)
  return { root, roots, transcript }
}

it('delivers one message stream to every registered consumer', async () => {
  const { roots } = await writeClaudeFixture()
  const first = recordingConsumer()
  const second = recordingConsumer()

  const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

  expect(result.issues).toEqual([])
  const stream = textsFor(first.reads, 'claude')
  expect(stream).toEqual(textsFor(second.reads, 'claude'))
  expect(stream).toEqual([
    'user:ask 1',
    'assistant:reply 1',
    'tool:Bash: ls 1',
    'user:ask 2',
    'assistant:reply 2',
    'tool:Bash: ls 2',
    'user:ask 3',
    'assistant:reply 3',
    'tool:Bash: ls 3',
    'user:ask 4',
    'assistant:reply 4',
    'tool:Bash: ls 4'
  ])
  // The list's own fold keeps only the newest five preview turns, so the stream
  // is demonstrably the reader's, not a projection of the session row.
  const session = result.sessions.find((entry) => entry.agent === 'claude')
  expect(session?.previewMessages).toHaveLength(5)
  expect(session?.messageCount).toBe(8)
})

it('leaves the session list identical whether or not a consumer is registered', async () => {
  const withoutConsumer = await writeClaudeFixture()
  const bare = await scanAiVaultSessions({
    ...withoutConsumer.roots,
    platform: 'darwin',
    limit: 20
  })

  resetSessionParseCacheForTests()
  recordingConsumer()
  const observed = await scanAiVaultSessions({
    ...withoutConsumer.roots,
    platform: 'darwin',
    limit: 20
  })

  expect(observed.sessions).toEqual(bare.sessions)
})

it('replays only the appended lines on a resumed read', async () => {
  const { roots, transcript } = await writeClaudeFixture()
  const consumer = recordingConsumer()
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })
  const firstRead = consumer.reads.at(-1)
  expect(firstRead?.start.mode).toBe('replace')
  expect(firstRead?.start.previousByteOffset).toBe(0)
  expect(firstRead?.outcome?.incomplete).toBe(false)

  await appendFile(transcript, `${jsonLines(claudeTurns(5, 5))}\n`)
  consumer.reads.length = 0
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

  const resumed = consumer.reads.find((read) => read.start.candidate.agent === 'claude')
  expect(resumed?.start.mode).toBe('append')
  expect(resumed?.start.previousByteOffset).toBe(firstRead?.outcome?.byteOffset)
  expect(textsFor(consumer.reads, 'claude')).toEqual([
    'user:ask 5',
    'assistant:reply 5',
    'tool:Bash: ls 5'
  ])
})

it('publishes a trailing unterminated line once, when it is complete', async () => {
  const { roots, transcript } = await writeClaudeFixture()
  const consumer = recordingConsumer()
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

  // A half-written record: the list shows it, the stream must not carry it yet.
  const [partial] = claudeTurns(5, 5)
  await appendFile(transcript, JSON.stringify(partial))
  consumer.reads.length = 0
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })
  expect(textsFor(consumer.reads, 'claude')).toEqual([])

  await appendFile(transcript, '\n')
  consumer.reads.length = 0
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })
  expect(textsFor(consumer.reads, 'claude')).toEqual(['user:ask 5'])
})

it('keeps the session list working when a consumer throws', async () => {
  const { roots } = await writeClaudeFixture()
  registerTranscriptConsumer({
    beginRead: () => ({
      message: () => {
        throw new Error('consumer exploded')
      },
      finish: () => undefined
    })
  })
  const healthy = recordingConsumer()

  const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

  expect(result.issues).toEqual([])
  expect(result.sessions.find((entry) => entry.agent === 'claude')?.messageCount).toBe(8)
  expect(textsFor(healthy.reads, 'claude')).toHaveLength(12)
})

it('skips a read a consumer declines without disturbing the others', async () => {
  const { roots } = await writeClaudeFixture()
  registerTranscriptConsumer({ beginRead: () => null })
  const healthy = recordingConsumer()

  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

  expect(textsFor(healthy.reads, 'claude')).toHaveLength(12)
})

async function claudeCandidate(transcript: string): Promise<SessionFileCandidate> {
  const stats = await stat(transcript)
  const file: FileWithMtime = {
    path: transcript,
    mtimeMs: stats.mtimeMs,
    modifiedAt: stats.mtime.toISOString(),
    sizeBytes: stats.size
  }
  return { agent: 'claude', file, codexHome: null }
}

it('serializes overlapping parses of one path so no consumer read is orphaned', async () => {
  const { transcript } = await writeClaudeFixture()
  // Seed a resume point: the channel it stores is what concurrent reads share.
  await parseAgentSessionFileCached(await claudeCandidate(transcript), 'darwin')

  await appendFile(transcript, `${jsonLines(claudeTurns(5, 5))}\n`)
  const consumer = recordingConsumer()
  const appended = await claudeCandidate(transcript)

  const [first, second] = await Promise.all([
    parseAgentSessionFileCached(appended, 'darwin'),
    parseAgentSessionFileCached(appended, 'darwin')
  ])

  // Every read that opened must also close, or its consumer keeps a half-read
  // stream forever and never learns the outcome.
  expect(consumer.reads.filter((read) => read.outcome === null)).toEqual([])
  expect(consumer.reads).toHaveLength(1)
  expect(consumer.reads[0].start.mode).toBe('append')
  expect(textsFor(consumer.reads, 'claude')).toEqual([
    'user:ask 5',
    'assistant:reply 5',
    'tool:Bash: ls 5'
  ])
  // The later caller reuses the stored entry rather than moving the cursor back.
  expect(first?.messageCount).toBe(10)
  expect(second?.messageCount).toBe(10)
})

it('reports a read whose parser cannot publish its messages as not complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-opencode-'))
  tempRoots.push(root)
  const dbPath = join(root, 'opencode.db')
  await writeFile(dbPath, '')
  const consumer = recordingConsumer()

  const session = await readWholeTranscript({
    candidate: {
      agent: 'opencode',
      codexHome: null,
      file: {
        path: `${dbPath}#sqlite-session`,
        mtimeMs: 1,
        modifiedAt: new Date(1).toISOString(),
        sizeBytes: 10
      }
    },
    platform: 'darwin'
  })

  expect(session).toEqual(OPENCODE_SQLITE_SESSION)
  expect(consumer.reads).toHaveLength(1)
  expect(consumer.reads[0].messages).toEqual([])
  expect(consumer.reads[0].outcome?.incomplete).toBe(true)
})

it('reports the transcript size, not the cache key, as a whole-file read offset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-cline-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  // Cline is whole-file and declares a sibling content dependency, so its cache
  // key covers two files while the read covers one.
  const sessionDir = join(roots.clineSessionsDir, 'cline-session')
  await mkdir(sessionDir, { recursive: true })
  const metadataPath = join(sessionDir, 'cline-session.json')
  await writeFile(
    metadataPath,
    JSON.stringify({
      session_id: 'cline-session',
      started_at: '2026-05-01T10:00:00.000Z',
      cwd: '/tmp/cline'
    })
  )
  await writeFile(
    join(sessionDir, 'cline-session.messages.json'),
    JSON.stringify({
      updated_at: '2026-05-01T10:00:01.000Z',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }]
    })
  )
  const consumer = recordingConsumer()

  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

  const read = consumer.reads.find((entry) => entry.start.candidate.agent === 'cline')
  expect(read?.outcome?.byteOffset).toBe((await stat(metadataPath)).size)
})
