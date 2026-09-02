import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cursorChatMetaPath,
  readCursorChatMeta,
  resetCursorChatMetaIndexCacheForTests
} from './session-scanner-cursor-chat-meta'
import {
  createCursorSessionResumeState,
  parseCursorSessionContent,
  parseCursorSessionFile
} from './session-scanner-cursor-parser'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { discoverFiles } from './session-scanner-discovery'
import type { FileWithMtime, SessionFileDiscovery } from './session-scanner-types'

// Cursor's real meta.json keys (~/.cursor/chats/<md5 of cwd>/<uuid>/meta.json, 2026-09).
type CursorMetaFixture = {
  schemaVersion: number
  createdAtMs: number
  updatedAtMs: number
  cwd: string
  hasConversation: boolean
  title?: string
}

const CREATED_AT_MS = 1_787_039_612_017
const UPDATED_AT_MS = 1_787_039_640_532

let tempRoots: string[] = []

afterEach(async () => {
  resetCursorChatMetaIndexCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function createCursorHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-cursor-chat-meta-'))
  tempRoots.push(root)
  const cursorHome = join(root, '.cursor')
  await mkdir(cursorHome, { recursive: true })
  return cursorHome
}

async function writeTranscript(
  cursorHome: string,
  projectSlug: string,
  chatId: string,
  lines: string[]
): Promise<string> {
  const chatDir = join(cursorHome, 'projects', projectSlug, 'agent-transcripts', chatId)
  await mkdir(chatDir, { recursive: true })
  const transcriptPath = join(chatDir, `${chatId}.jsonl`)
  await writeFile(transcriptPath, lines.map((line) => `${line}\n`).join(''))
  return transcriptPath
}

async function writeChatMeta(
  cursorHome: string,
  workspaceHash: string,
  chatId: string,
  meta: Partial<CursorMetaFixture> = {}
): Promise<string> {
  const chatDir = join(cursorHome, 'chats', workspaceHash, chatId)
  await mkdir(chatDir, { recursive: true })
  const metaPath = join(chatDir, 'meta.json')
  await writeFile(
    metaPath,
    JSON.stringify({
      schemaVersion: 1,
      createdAtMs: CREATED_AT_MS,
      updatedAtMs: UPDATED_AT_MS,
      cwd: '/private/tmp/workspace',
      hasConversation: true,
      ...meta
    } satisfies CursorMetaFixture)
  )
  return metaPath
}

function fileWithMtime(path: string): FileWithMtime {
  return { path, mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
}

describe('cursor chat meta', () => {
  it('resolves the meta.json under the workspace hash that holds the chat id', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'aa37220647fb7ce5eb044aa4bda60807', 'other-chat')
    const metaPath = await writeChatMeta(cursorHome, '96fa26ac0f433670ebec73ecef20b47b', 'chat-1', {
      title: 'Shell Command Hostname'
    })
    const transcriptPath = await writeTranscript(cursorHome, 'private-tmp-workspace', 'chat-1', [])

    expect(await cursorChatMetaPath(transcriptPath)).toBe(metaPath)
    expect(await readCursorChatMeta(transcriptPath)).toEqual({
      title: 'Shell Command Hostname',
      cwd: '/private/tmp/workspace',
      createdAt: new Date(CREATED_AT_MS).toISOString(),
      updatedAt: new Date(UPDATED_AT_MS).toISOString()
    })
  })

  it('re-indexes after a chat appears under an already indexed workspace', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-first')
    const firstTranscript = await writeTranscript(cursorHome, 'slug', 'chat-first', [])
    expect(await cursorChatMetaPath(firstTranscript)).toBeDefined()

    const laterMetaPath = await writeChatMeta(cursorHome, 'workspace-hash', 'chat-later')
    const laterTranscript = await writeTranscript(cursorHome, 'slug', 'chat-later', [])

    expect(await cursorChatMetaPath(laterTranscript)).toBe(laterMetaPath)
  })

  it('yields nothing and does not throw when there is no chats tree', async () => {
    const cursorHome = await createCursorHome()
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-orphan', [])

    await expect(cursorChatMetaPath(transcriptPath)).resolves.toBeUndefined()
    await expect(readCursorChatMeta(transcriptPath)).resolves.toBeNull()
    await expect(readCursorChatMeta('/nowhere/near/cursor/chat.jsonl')).resolves.toBeNull()
  })

  it('yields nothing and does not throw when meta.json is malformed', async () => {
    const cursorHome = await createCursorHome()
    const chatDir = join(cursorHome, 'chats', 'workspace-hash', 'chat-bad')
    await mkdir(chatDir, { recursive: true })
    await writeFile(join(chatDir, 'meta.json'), '{ not json')
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-bad', [])

    await expect(readCursorChatMeta(transcriptPath)).resolves.toBeNull()
  })
})

describe('cursor discovery meta dependency', () => {
  it('folds meta.json into candidate freshness so a rewrite invalidates the parse cache', async () => {
    const cursorHome = await createCursorHome()
    const metaPath = await writeChatMeta(cursorHome, 'workspace-hash', 'chat-7')
    await writeTranscript(cursorHome, 'slug', 'chat-7', [])
    const issues: AiVaultScanIssue[] = []
    const discover = (): Promise<SessionFileDiscovery> =>
      discoverFiles({
        rootDir: join(cursorHome, 'projects'),
        limit: 10,
        agent: 'cursor',
        issues,
        extensions: [...AI_VAULT_AGENT_SOURCES.cursor.extensions],
        filePredicate: AI_VAULT_AGENT_SOURCES.cursor.filePredicate,
        contentDependencyPath: AI_VAULT_AGENT_SOURCES.cursor.contentDependencyPath
      })

    const before = (await discover()).files[0]
    const future = new Date(Date.now() + 10_000)
    await utimes(metaPath, future, future)
    const after = (await discover()).files[0]

    expect(after?.mtimeMs).toBeGreaterThan(before?.mtimeMs ?? 0)
    expect(issues).toEqual([])
  })
})

describe('cursor parser chat meta fallback', () => {
  it('fills cwd, timestamps and title from meta.json', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-2', { title: 'Named From Meta' })
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-2', [
      JSON.stringify({ role: 'assistant', message: { content: 'hello' } })
    ])

    const session = await parseCursorSessionFile(fileWithMtime(transcriptPath), 'darwin')

    expect(session?.cwd).toBe('/private/tmp/workspace')
    expect(session?.title).toBe('Named From Meta')
    expect(session?.createdAt).toBe(new Date(CREATED_AT_MS).toISOString())
    expect(session?.updatedAt).toBe(new Date(UPDATED_AT_MS).toISOString())
  })

  it('keeps a transcript title and timestamps over meta.json', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-3', { title: 'Meta Title' })
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-3', [
      JSON.stringify({
        role: 'user',
        message: { content: 'transcript first prompt' },
        timestamp: '2026-01-01T00:00:00.000Z'
      })
    ])

    const session = await parseCursorSessionFile(fileWithMtime(transcriptPath), 'darwin')

    expect(session?.title).toBe('transcript first prompt')
    expect(session?.createdAt).toBe('2026-01-01T00:00:00.000Z')
    // cwd is never in the transcript, so it still comes from meta.json.
    expect(session?.cwd).toBe('/private/tmp/workspace')
  })

  it('builds the resume command from the meta.json cwd', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-4', { cwd: '/repo/from-meta' })
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-4', [
      JSON.stringify({ role: 'user', message: { content: 'hi' } })
    ])

    const session = await parseCursorSessionFile(fileWithMtime(transcriptPath), 'darwin')

    expect(session?.resumeCommand).toContain('/repo/from-meta')
  })

  it('leaves remote content parses to the transcript alone', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-5', { title: 'Meta Title' })
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-5', [])

    const session = await parseCursorSessionContent(
      fileWithMtime(transcriptPath),
      `${JSON.stringify({ role: 'assistant', message: { content: 'remote' } })}\n`,
      'linux'
    )

    expect(session?.cwd).toBeNull()
    expect(session?.title).not.toBe('Meta Title')
  })

  it('applies the fallback on every finalize of a resumed parse', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-6', { title: 'Resumed Meta' })
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-6', [])

    const state = createCursorSessionResumeState(fileWithMtime(transcriptPath))
    state.consumeLine(JSON.stringify({ role: 'assistant', message: { content: 'first' } }))
    const first = await state.finalize('darwin')
    state.consumeLine(JSON.stringify({ role: 'assistant', message: { content: 'second' } }))
    const second = await state.finalize('darwin')

    expect(first?.cwd).toBe('/private/tmp/workspace')
    expect(second?.title).toBe('Resumed Meta')
    expect(second?.messageCount).toBe(2)
  })
})
