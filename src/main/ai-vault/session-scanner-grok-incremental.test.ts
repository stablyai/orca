import { appendFile, mkdtemp, rm, stat, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'
import { registerTranscriptConsumer } from './session-transcript-consumers'

let root: string
let summary: string
let history: string
let revision = 0
const line = (type: string, content: string): string =>
  JSON.stringify({ type, content, timestamp: '2026-05-01T10:00:01.000Z' })

beforeEach(async () => {
  resetSessionParseCacheForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-grok-append-'))
  summary = join(root, 'summary.json')
  history = join(root, 'chat_history.jsonl')
  await writeFile(
    summary,
    JSON.stringify({
      info: { id: 'grok-session', cwd: '/repo' },
      generated_title: 'Title',
      num_chat_messages: 2
    })
  )
  await writeFile(history, `${line('user', 'Explain 世界')}\n`)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function candidate(): Promise<SessionFileCandidate> {
  const info = await stat(summary)
  return {
    agent: 'grok',
    file: {
      path: summary,
      mtimeMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString(),
      sizeBytes: info.size
    },
    codexHome: null
  }
}

async function parse() {
  const input = await candidate()
  const stats = createSessionParseStats()
  const session = await parseAgentSessionFileCached(input, process.platform, stats)
  expect(session).toEqual(await parseAgentSessionFile(input, process.platform))
  return { session, stats }
}

async function rewrite(path: string, content: string): Promise<void> {
  await writeFile(path, content)
  const time = new Date(Date.now() + ++revision * 1000)
  await utimes(path, time, time)
}

it('reads only appended history bytes, even when the summary is unchanged', async () => {
  const seed = await parse()
  expect(seed.stats.fullParses).toBe(1)
  expect((await parse()).stats.reused).toBe(1)
  const appended = `${line('assistant', 'Answer 😀')}\n`
  await appendFile(history, appended)
  const next = await parse()
  expect(next.stats).toMatchObject({
    incremental: 1,
    fullParses: 0,
    bytesRead: Buffer.byteLength(appended)
  })
  expect(next.session?.filePath).toBe(summary)
})

it('refreshes and removes rewritten summary fields without rereading history', async () => {
  await parse()
  await rewrite(
    summary,
    JSON.stringify({
      info: { id: 'grok-session', cwd: '/new' },
      generated_title: 'New title',
      num_chat_messages: 9
    })
  )
  const changed = await parse()
  expect(changed.stats).toMatchObject({ incremental: 1, bytesRead: 0 })
  expect(changed.session).toMatchObject({ title: 'New title', cwd: '/new', messageCount: 9 })
  await rewrite(summary, JSON.stringify({ info: { id: 'grok-session' } }))
  expect((await parse()).session).toMatchObject({ title: 'Explain 世界', cwd: null })
})

it('reparses truncated and same-size rewritten history', async () => {
  await parse()
  const replacement = `${line('user', 'Changed')}\n`
  await rewrite(history, replacement)
  expect((await parse()).stats.fullParses).toBe(1)
  await rewrite(history, replacement.replace('Changed', 'Updated'))
  expect((await parse()).stats.fullParses).toBe(1)
})

it('does not commit a trailing partial line into the resume state', async () => {
  const next = line('assistant', 'Completed')
  await appendFile(history, next.slice(0, 20))
  await parse()
  await appendFile(history, `${next.slice(20)}\n`)
  expect((await parse()).stats.incremental).toBe(1)
})

it('handles history appearing, disappearing, and returning beside a summary', async () => {
  await rm(history)
  await parse()
  await writeFile(history, `${line('user', 'Arrived')}\n`)
  expect((await parse()).stats.fullParses).toBe(1)
  await rm(history)
  expect((await parse()).session?.previewMessages).toEqual([])
  await writeFile(history, `${line('user', 'Returned')}\n`)
  expect((await parse()).stats.fullParses).toBe(1)
})

it('publishes append messages under the summary identity with history offsets', async () => {
  const reads: { path: string; mode: string; previous: number; texts: string[]; end?: number }[] =
    []
  const unregister = registerTranscriptConsumer({
    beginRead(start) {
      const read: (typeof reads)[number] = {
        path: start.candidate.file.path,
        mode: start.mode,
        previous: start.previousByteOffset,
        texts: []
      }
      reads.push(read)
      return {
        message: (message) => read.texts.push(message.text),
        finish: (outcome) => {
          read.end = outcome.byteOffset
        }
      }
    }
  })
  try {
    await parseAgentSessionFileCached(await candidate(), process.platform)
    const offset = (await stat(history)).size
    await appendFile(history, `${line('assistant', 'Indexed answer')}\n`)
    await parseAgentSessionFileCached(await candidate(), process.platform)
    expect(reads).toHaveLength(2)
    expect(reads[1]).toMatchObject({
      path: summary,
      mode: 'append',
      previous: offset,
      texts: ['Indexed answer'],
      end: (await stat(history)).size
    })
  } finally {
    unregister()
  }
})
