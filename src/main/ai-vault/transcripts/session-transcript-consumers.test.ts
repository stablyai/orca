import { appendFile, mkdir, mkdtemp, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { scanAiVaultSessions } from '../session-scanner'
import { parseAgentSessionFileCached } from '../parse-cache/session-scanner-parse-cache'
import { resetSessionParseCacheForTests } from '../parse-cache/session-parse-cache-store'
import { isolatedScanRoots, jsonLines } from '../session-scanner-test-fixtures'
import type { FileWithMtime, SessionFileCandidate } from '../session-scanner-types'

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

it('replays only the appended lines on a resumed read', async () => {
  const { roots, transcript } = await writeClaudeFixture()
  const consumer = recordingConsumer()
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })
  const firstRead = consumer.reads.at(-1)
  expect(firstRead?.start.mode).toBe('replace')
  expect(firstRead?.start.previousByteOffset).toBe(0)
  expect(firstRead?.outcome?.incomplete).toBe(false)

  await appendFile(transcript, `${jsonLines(claudeTurns(5, 5))}\n`)
  const changedAt = new Date(firstRead!.start.candidate.file.mtimeMs + 2000)
  await utimes(transcript, changedAt, changedAt)
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

it.each(['rewrite', 'truncate then regrow'])(
  're-reads a same-size %s from zero',
  async (operation) => {
    const { transcript } = await writeClaudeFixture()
    const before = await claudeCandidate(transcript)
    await parseAgentSessionFileCached(before, 'darwin')
    const consumer = recordingConsumer()
    const rewritten = `${jsonLines(claudeTurns(1, 4))}\n`.replace('reply 4', 'fresh 4')
    expect(Buffer.byteLength(rewritten)).toBe(before.file.sizeBytes)

    if (operation === 'truncate then regrow') {
      await truncate(transcript, 0)
      await appendFile(transcript, rewritten)
    } else {
      await writeFile(transcript, rewritten)
    }
    const changedAt = new Date(before.file.mtimeMs + 2000)
    await utimes(transcript, changedAt, changedAt)
    const session = await parseAgentSessionFileCached(await claudeCandidate(transcript), 'darwin')

    expect(consumer.reads).toHaveLength(1)
    expect(consumer.reads[0].start.mode).toBe('replace')
    expect(consumer.reads[0].start.previousByteOffset).toBe(0)
    expect(textsFor(consumer.reads, 'claude')).toContain('assistant:fresh 4')
    expect(textsFor(consumer.reads, 'claude')).not.toContain('assistant:reply 4')
    resetSessionParseCacheForTests()
    expect(session).toEqual(
      await parseAgentSessionFileCached(await claudeCandidate(transcript), 'darwin')
    )
  }
)

it('publishes a trailing unterminated line once, when it is complete', async () => {
  const { roots, transcript } = await writeClaudeFixture()
  const consumer = recordingConsumer()
  await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

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
  await parseAgentSessionFileCached(await claudeCandidate(transcript), 'darwin')

  await appendFile(transcript, `${jsonLines(claudeTurns(5, 5))}\n`)
  const consumer = recordingConsumer()
  const appended = await claudeCandidate(transcript)

  const [first, second] = await Promise.all([
    parseAgentSessionFileCached(appended, 'darwin'),
    parseAgentSessionFileCached(appended, 'darwin')
  ])

  expect(consumer.reads.filter((read) => read.outcome === null)).toEqual([])
  expect(consumer.reads).toHaveLength(1)
  expect(consumer.reads[0].start.mode).toBe('append')
  expect(textsFor(consumer.reads, 'claude')).toEqual([
    'user:ask 5',
    'assistant:reply 5',
    'tool:Bash: ls 5'
  ])
  expect(first?.messageCount).toBe(10)
  expect(second?.messageCount).toBe(10)
})
