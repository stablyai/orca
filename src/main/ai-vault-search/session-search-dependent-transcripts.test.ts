import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from '../ai-vault/session-scanner-parse-cache'
import { resetCodexSessionIndexTitleCacheForTests } from '../ai-vault/session-scanner-codex-title-index'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'
import {
  CODEX_ROLLOUT_FILE,
  CODEX_SESSION_ID,
  codexRolloutLines,
  sessionCandidate
} from './session-search-transcript-fixtures'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let root: string
let errors: unknown[]
const SESSION_ID = '0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d'

beforeEach(async () => {
  resetTranscriptConsumersForTests()
  resetCodexSessionIndexTitleCacheForTests()
  index = await openSessionSearchIndexFile('ss-dependent-transcripts')
  root = dirname(index.path)
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  resetCodexSessionIndexTitleCacheForTests()
  store.close()
  await index.close()
})

async function writeSource(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function coldRead(candidate: SessionFileCandidate) {
  resetSessionParseCacheForTests()
  const session = await parseAgentSessionFileCached(candidate, process.platform)
  expect(errors).toEqual([])
  expect(session).not.toBeNull()
  return session
}

function matches(term: string): unknown {
  return index.db
    .prepare(
      `SELECT count(*) AS n FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_row_id
       WHERE messages_fts MATCH ?`
    )
    .get(term)
}

it.each(['cline', 'kiro'] as const)(
  'removes old searchable messages when the %s sidecar is deleted',
  async (agent) => {
    const path = join(root, agent, SESSION_ID, `${SESSION_ID}.json`)
    const sidecarPath = agent === 'cline' ? path.replace(/\.json$/, '.messages.json') : `${path}l`
    await writeSource(path, JSON.stringify({ session_id: SESSION_ID, title: 'Conversation' }))
    await writeSource(
      sidecarPath,
      agent === 'cline'
        ? JSON.stringify({ messages: [{ role: 'user', content: 'oldsidecarmessage' }] })
        : `${JSON.stringify({
            kind: 'Prompt',
            data: { content: [{ kind: 'text', data: 'oldsidecarmessage' }] }
          })}\n`
    )
    const candidate = await sessionCandidate(agent, path)
    const sidecar = await stat(sidecarPath)
    candidate.file.sidecar = {
      path: sidecarPath,
      mtimeMs: sidecar.mtimeMs,
      sizeBytes: sidecar.size
    }
    await coldRead(candidate)
    expect(matches('oldsidecarmessage')).toEqual({ n: 1 })

    await unlink(sidecarPath)
    const after = await sessionCandidate(agent, path)
    expect(after.file).toEqual({ ...candidate.file, sidecar: undefined })
    after.file.sidecar = 'none'
    expect(await coldRead(after)).toMatchObject({ messageCount: 0 })
    expect(matches('oldsidecarmessage')).toEqual({ n: 0 })
    expect(index.db.prepare('SELECT state FROM files').get()).toEqual({ state: 'current' })
  }
)

it.each(['opencode', 'kimi', 'grok'] as const)(
  'repairs %s search content after a cold reread of unchanged candidate metadata',
  async (agent) => {
    const source = await multiFileSource(agent)
    await writeSource(source.messagesPath, source.message('olddependentmessage'))
    const candidate = await sessionCandidate(agent, source.path)
    candidate.file.sidecar = 'none'
    await coldRead(candidate)
    expect(matches('olddependentmessage')).toEqual({ n: 1 })

    await writeSource(source.messagesPath, source.message('newdependentmessage'))
    expect((await sessionCandidate(agent, source.path)).file).toEqual({
      ...candidate.file,
      sidecar: undefined
    })
    const session = await coldRead(candidate)
    expect(session?.previewMessages).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'newdependentmessage' })])
    )
    expect(matches('newdependentmessage')).toEqual({ n: 1 })
    expect(matches('olddependentmessage')).toEqual({ n: 0 })
  }
)

async function multiFileSource(agent: 'opencode' | 'kimi' | 'grok') {
  if (agent === 'opencode') {
    const path = join(root, 'storage', 'session', 'project', 'ses_fixture.json')
    await writeSource(path, JSON.stringify({ id: SESSION_ID, title: 'Conversation' }))
    return {
      path,
      messagesPath: join(root, 'storage', 'message', SESSION_ID, 'msg_fixture.json'),
      message: (text: string) => JSON.stringify({ role: 'user', content: text })
    }
  }
  if (agent === 'kimi') {
    const directory = join(root, 'kimi', 'sessions', 'wd_app_abc', `session_${SESSION_ID}`)
    const path = join(directory, 'state.json')
    await writeSource(path, JSON.stringify({ title: 'Conversation' }))
    return {
      path,
      messagesPath: join(directory, 'agents', 'main', 'wire.jsonl'),
      message: (text: string) =>
        `${JSON.stringify({
          type: 'context.append_message',
          message: { role: 'user', origin: { kind: 'user' }, content: text }
        })}\n`
    }
  }
  const path = join(root, 'grok', SESSION_ID, 'summary.json')
  await writeSource(
    path,
    JSON.stringify({ info: { id: SESSION_ID }, generated_title: 'Conversation' })
  )
  return {
    path,
    messagesPath: join(dirname(path), 'chat_history.jsonl'),
    message: (text: string) =>
      `${JSON.stringify({ type: 'user', content: `<user_query>${text}</user_query>` })}\n`
  }
}

it('updates the indexed Codex title when only session_index.jsonl changes', async () => {
  const home = join(root, 'codex')
  const path = join(home, 'sessions', CODEX_ROLLOUT_FILE)
  await writeSource(path, `${codexRolloutLines(['pwd'], '/repo/app', 'codexmessage').join('\n')}\n`)
  const titleIndex = join(home, 'session_index.jsonl')
  await writeSource(
    titleIndex,
    `${JSON.stringify({ id: CODEX_SESSION_ID, thread_name: 'Original' })}\n`
  )
  const candidate = await sessionCandidate('codex', path, home)
  candidate.file.sidecar = 'none'
  await coldRead(candidate)
  expect(index.db.prepare('SELECT title FROM sessions').get()).toEqual({ title: 'Original' })

  await writeSource(
    titleIndex,
    `${JSON.stringify({ id: CODEX_SESSION_ID, thread_name: 'Renamed conversation' })}\n`
  )
  expect((await sessionCandidate('codex', path, home)).file).toEqual({
    ...candidate.file,
    sidecar: undefined
  })
  expect(await coldRead(candidate)).toMatchObject({ title: 'Renamed conversation' })
  expect(index.db.prepare('SELECT title FROM sessions').get()).toEqual({
    title: 'Renamed conversation'
  })
  expect(matches('codexmessage')).toEqual({ n: 1 })
})
