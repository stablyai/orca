import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-error'

// Why: a refused WSL read is the one build failure that must not be cached.
let failNextChatsReaddir = false
let failNextChatsRootReaddir = false
let failMetaJsonReads = false
let failMetaJsonStats: false | true | 'eacces' = false
let chatsRootReads = 0
vi.mock('../native-chat/wsl-transcript-fs-access', async (importOriginal) => {
  const actual = await importOriginal<typeof WslTranscriptFsAccess>()
  return {
    ...actual,
    wslGatedReaddir: (
      ...args: Parameters<typeof actual.wslGatedReaddir>
    ): ReturnType<typeof actual.wslGatedReaddir> => {
      if (args[0].endsWith('chats')) {
        chatsRootReads += 1
        if (failNextChatsRootReaddir) {
          failNextChatsRootReaddir = false
          return Promise.reject(new WslTranscriptFsError('timeout', 'wsl fs timed out'))
        }
      }
      if (failNextChatsReaddir && args[0].includes('workspace-hash')) {
        failNextChatsReaddir = false
        return Promise.reject(new WslTranscriptFsError('timeout', 'wsl fs timed out'))
      }
      return actual.wslGatedReaddir(...args)
    },
    wslGatedReadFile: (
      ...args: Parameters<typeof actual.wslGatedReadFile>
    ): ReturnType<typeof actual.wslGatedReadFile> => {
      if (failMetaJsonReads && String(args[0]).endsWith('meta.json')) {
        return Promise.reject(new WslTranscriptFsError('timeout', 'wsl fs timed out'))
      }
      return actual.wslGatedReadFile(...args)
    },
    wslGatedStat: (
      ...args: Parameters<typeof actual.wslGatedStat>
    ): ReturnType<typeof actual.wslGatedStat> => {
      if (failMetaJsonStats && String(args[0]).endsWith('meta.json')) {
        return Promise.reject(
          failMetaJsonStats === 'eacces'
            ? Object.assign(new Error('permission denied'), { code: 'EACCES' })
            : new WslTranscriptFsError('timeout', 'wsl fs timed out')
        )
      }
      return actual.wslGatedStat(...args)
    }
  }
})
import type * as WslTranscriptFsAccess from '../native-chat/wsl-transcript-fs-access'
import {
  cursorChatMetaPath,
  readCursorChatMeta,
  resetCursorChatMetaIndexCacheForTests,
  withCursorChatMetaScan
} from './session-scanner-cursor-chat-meta'
import { parseCursorSessionContent } from './session-scanner-cursor-parser'
import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { discoverFiles } from './session-scanner-discovery'
import { scanAiVaultSessions } from './session-scanner'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  seedSessionParseCache,
  snapshotSessionParseCacheForPersistence,
  type SessionParseStats
} from './session-scanner-parse-cache'
import {
  getSessionParseCacheEntry,
  type PersistedSessionParseCacheEntry
} from './session-parse-cache-store'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import type { FileWithMtime } from './session-scanner-types'
import type { SessionSidecarStat } from './session-sidecar-stat'

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
  resetSessionParseCacheForTests()
  failNextChatsRootReaddir = false
  failMetaJsonReads = false
  failMetaJsonStats = false
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

  it('does not cache a metadata index whose build was refused by the WSL gate', async () => {
    const cursorHome = await createCursorHome()
    const metaPath = await writeChatMeta(cursorHome, 'workspace-hash', 'chat-refused')
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-refused', [])

    failNextChatsReaddir = true
    // A refusal degrades to "no metadata" rather than taking the session down.
    await expect(cursorChatMetaPath(transcriptPath)).resolves.toBeUndefined()
    // The next scan rebuilds instead of replaying the rejected promise.
    await expect(cursorChatMetaPath(transcriptPath)).resolves.toBe(metaPath)
  })

  it('validates the index once per scan, not once per transcript', async () => {
    const cursorHome = await createCursorHome()
    const transcripts: string[] = []
    for (const chatId of ['chat-a', 'chat-b', 'chat-c']) {
      await writeChatMeta(cursorHome, 'workspace-hash', chatId)
      transcripts.push(await writeTranscript(cursorHome, 'slug', chatId, []))
    }
    chatsRootReads = 0

    const inScan = await withCursorChatMetaScan(() =>
      Promise.all(transcripts.map((path) => cursorChatMetaPath(path)))
    )
    expect(inScan.every(Boolean)).toBe(true)
    expect(chatsRootReads).toBe(1)

    // Outside a scan every lookup re-validates, which is what the parse path needs.
    chatsRootReads = 0
    await Promise.all(transcripts.map((path) => cursorChatMetaPath(path)))
    expect(chatsRootReads).toBe(3)
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

async function cursorCandidate(cursorHome: string): Promise<FileWithMtime> {
  const issues: AiVaultScanIssue[] = []
  const discovery = await discoverFiles({
    rootDir: join(cursorHome, 'projects'),
    limit: 10,
    agent: 'cursor',
    issues,
    extensions: [...AI_VAULT_AGENT_SOURCES.cursor.extensions],
    filePredicate: AI_VAULT_AGENT_SOURCES.cursor.filePredicate,
    contentDependencyPath: AI_VAULT_AGENT_SOURCES.cursor.contentDependencyPath
  })
  return discovery.files[0]
}

/** The production path: the parse cache owns the sidecar merge, not the parser. */
function parseCursorCached(
  file: FileWithMtime,
  stats: SessionParseStats = createSessionParseStats()
): Promise<{ session: AiVaultSession | null; stats: SessionParseStats }> {
  return withCursorChatMetaScan(async () => {
    const session = await parseAgentSessionFileCached(
      { agent: 'cursor', file, codexHome: null },
      'darwin',
      stats
    )
    return { session, stats }
  })
}

async function writeCursorScanFixture(chatIds: string[]): Promise<{
  cursorHome: string
  scanOptions: ReturnType<typeof isolatedScanRoots> & { cursorProjectsDir: string }
}> {
  const cursorHome = await createCursorHome()
  for (const chatId of chatIds) {
    await writeChatMeta(cursorHome, 'workspace-hash', chatId, { cwd: `/tmp/ws-${chatId}` })
    await writeTranscript(cursorHome, 'slug', chatId, [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: chatId }] } })
    ])
  }
  const root = join(cursorHome, '..')
  return {
    cursorHome,
    scanOptions: {
      ...isolatedScanRoots(root),
      cursorProjectsDir: join(cursorHome, 'projects')
    }
  }
}

describe('cursor discovery sidecar observation', () => {
  it('records meta.json beside the transcript stat instead of folding it in', async () => {
    const cursorHome = await createCursorHome()
    const metaPath = await writeChatMeta(cursorHome, 'workspace-hash', 'chat-7')
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-7', [])

    const before = await cursorCandidate(cursorHome)
    const future = new Date(Date.now() + 10_000)
    await utimes(metaPath, future, future)
    const after = await cursorCandidate(cursorHome)

    // The transcript's own key is untouched by a sibling rewrite.
    const transcriptStat = await stat(transcriptPath)
    expect(after.mtimeMs).toBe(transcriptStat.mtimeMs)
    expect(after.sizeBytes).toBe(transcriptStat.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    // The sibling is observed separately, and it did move.
    expect(before.sidecar).toMatchObject({ path: metaPath })
    expect(after.sidecar).toMatchObject({ path: metaPath })
    expect((after.sidecar as SessionSidecarStat).mtimeMs).toBeGreaterThan(
      (before.sidecar as SessionSidecarStat).mtimeMs
    )
  })
})

describe('cursor sidecar enrichment', () => {
  it('fills cwd, timestamps and title from meta.json', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-2', { title: 'Named From Meta' })
    await writeTranscript(cursorHome, 'slug', 'chat-2', [
      JSON.stringify({ role: 'assistant', message: { content: 'hello' } })
    ])
    resetSessionParseCacheForTests()

    const { session } = await parseCursorCached(await cursorCandidate(cursorHome))

    expect(session?.cwd).toBe('/private/tmp/workspace')
    expect(session?.title).toBe('Named From Meta')
    expect(session?.createdAt).toBe(new Date(CREATED_AT_MS).toISOString())
    expect(session?.updatedAt).toBe(new Date(UPDATED_AT_MS).toISOString())
  })

  it('keeps a transcript title and timestamps over meta.json', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-3', { title: 'Meta Title' })
    await writeTranscript(cursorHome, 'slug', 'chat-3', [
      JSON.stringify({
        role: 'user',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { content: 'transcript first prompt' }
      })
    ])
    resetSessionParseCacheForTests()

    const { session } = await parseCursorCached(await cursorCandidate(cursorHome))

    expect(session?.title).toBe('transcript first prompt')
    expect(session?.createdAt).toBe('2026-01-01T00:00:00.000Z')
    // cwd is never in the transcript, so it still comes from meta.json.
    expect(session?.cwd).toBe('/private/tmp/workspace')
  })

  it('builds the resume command from the meta.json cwd', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-4', { cwd: '/repo/from-meta' })
    await writeTranscript(cursorHome, 'slug', 'chat-4', [
      JSON.stringify({ role: 'user', message: { content: 'hi' } })
    ])
    resetSessionParseCacheForTests()

    const { session } = await parseCursorCached(await cursorCandidate(cursorHome))

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

  it('re-enriches without a parse when only the sidecar is rewritten', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-8', { cwd: '/repo/first' })
    await writeTranscript(cursorHome, 'slug', 'chat-8', [
      JSON.stringify({ role: 'user', message: { content: 'hi' } })
    ])
    resetSessionParseCacheForTests()
    await parseCursorCached(await cursorCandidate(cursorHome))

    const future = new Date(Date.now() + 10_000)
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-8', { cwd: '/repo/second' })
    await utimes(join(cursorHome, 'chats', 'workspace-hash', 'chat-8', 'meta.json'), future, future)

    const { session, stats } = await parseCursorCached(await cursorCandidate(cursorHome))

    // The transcript is not re-read: the merge runs over the stored fold result.
    expect(stats.reused).toBe(1)
    expect(stats.fullParses).toBe(0)
    expect(stats.incremental).toBe(0)
    // A rewritten cwd REPLACES the merged one; `??=` on the cached session could
    // never do this, because the cached cwd is already non-null.
    expect(session?.cwd).toBe('/repo/second')
    expect(session?.resumeCommand).toContain('/repo/second')
  })

  it('treats a persisted entry with no sidecar as unknown and enriches once', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-9', { cwd: '/repo/persisted' })
    await writeTranscript(cursorHome, 'slug', 'chat-9', [
      JSON.stringify({ role: 'user', message: { content: 'hi' } })
    ])
    resetSessionParseCacheForTests()
    await parseCursorCached(await cursorCandidate(cursorHome))

    // What a build older than the sidecar field wrote: no such key.
    const persisted = snapshotSessionParseCacheForPersistence().map(
      ([path, entry]): [string, PersistedSessionParseCacheEntry] => {
        const { sidecar: _sidecar, ...rest } = entry
        return [path, rest]
      }
    )
    resetSessionParseCacheForTests()
    seedSessionParseCache(persisted)

    const { session, stats } = await parseCursorCached(await cursorCandidate(cursorHome))
    expect(stats.reused).toBe(0)
    expect(session?.cwd).toBe('/repo/persisted')
  })
})

describe('cursor chat meta scan failures', () => {
  it('lists cursor sessions without metadata when the chats tree is refused, then heals', async () => {
    const { cursorHome, scanOptions } = await writeCursorScanFixture(['chat-a', 'chat-b'])
    resetSessionParseCacheForTests()

    failNextChatsRootReaddir = true
    const refused = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
    const refusedCursor = refused.sessions.filter((session) => session.agent === 'cursor')
    expect(refusedCursor).toHaveLength(2)
    expect(refusedCursor.map((session) => session.cwd)).toEqual([null, null])
    // One issue for the chats root, not one per transcript.
    expect(refused.issues).toHaveLength(1)
    expect(refused.issues[0].path).toBe(join(cursorHome, 'chats'))
    expect(refused.issues[0].agent).toBe('cursor')

    const healed = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
    expect(healed.issues).toEqual([])
    expect(
      healed.sessions
        .filter((session) => session.agent === 'cursor')
        .map((session) => session.cwd)
        .sort()
    ).toEqual(['/tmp/ws-chat-a', '/tmp/ws-chat-b'])
  })

  it('re-enriches after a refused meta.json read without losing the resume cursor', async () => {
    const { scanOptions } = await writeCursorScanFixture(['chat-a'])
    resetSessionParseCacheForTests()

    failMetaJsonReads = true
    const refused = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
    const listed = refused.sessions.find((session) => session.agent === 'cursor')
    expect(listed?.cwd).toBeNull()
    expect(refused.issues).toHaveLength(1)

    // The sibling alone is unknown; the transcript's work and its resume point
    // are kept, so the next healthy scan merges without re-reading bytes.
    const entry = getSessionParseCacheEntry(listed?.filePath ?? '')
    expect(entry?.sidecar).toBe('unknown')
    expect(entry?.resume).not.toBeNull()

    failMetaJsonReads = false
    const healed = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
    expect(healed.issues).toEqual([])
    expect(healed.sessions.find((session) => session.agent === 'cursor')?.cwd).toBe(
      '/tmp/ws-chat-a'
    )
  })

  it('treats a local EACCES on the sidecar stat as unknown, not as absent', async () => {
    const { scanOptions } = await writeCursorScanFixture(['chat-a'])
    resetSessionParseCacheForTests()

    // On mac/Linux/Windows the gated stat is a bare fs stat, so a permissions
    // failure is not a WslTranscriptFsError and must not read as "no sidecar".
    failMetaJsonStats = 'eacces'
    const refused = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
    const listed = refused.sessions.find((session) => session.agent === 'cursor')
    expect(listed?.sessionId).toBeTruthy()
    expect(refused.issues).toHaveLength(1)
    expect(refused.issues[0].agent).toBe('cursor')
    expect(getSessionParseCacheEntry(listed?.filePath ?? '')?.sidecar).toBe('unknown')

    failMetaJsonStats = false
    const healed = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
    expect(healed.issues).toEqual([])
    expect(healed.sessions.find((session) => session.agent === 'cursor')?.cwd).toBe(
      '/tmp/ws-chat-a'
    )
  })

  it('lists a cursor session whose meta.json stat is refused instead of dropping it', async () => {
    const { scanOptions } = await writeCursorScanFixture(['chat-a'])
    resetSessionParseCacheForTests()

    failMetaJsonStats = true
    const refused = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
    expect(refused.sessions.filter((session) => session.agent === 'cursor')).toHaveLength(1)
    expect(refused.issues).toHaveLength(1)
    expect(refused.issues[0].agent).toBe('cursor')

    failMetaJsonStats = false
    const healed = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })
    expect(healed.issues).toEqual([])
    expect(healed.sessions.find((session) => session.agent === 'cursor')?.cwd).toBe(
      '/tmp/ws-chat-a'
    )
  })

  it('reads the chats root once per scan across discovery and parse', async () => {
    const { scanOptions } = await writeCursorScanFixture(['chat-a', 'chat-b', 'chat-c'])
    resetSessionParseCacheForTests()
    chatsRootReads = 0

    const result = await scanAiVaultSessions({ ...scanOptions, platform: 'darwin', limit: 20 })

    expect(result.sessions.filter((session) => session.agent === 'cursor')).toHaveLength(3)
    expect(chatsRootReads).toBe(1)
  })

  it('resumes an appended transcript after a refused sidecar scan', async () => {
    const cursorHome = await createCursorHome()
    await writeChatMeta(cursorHome, 'workspace-hash', 'chat-r', { cwd: '/repo/resume' })
    const transcriptPath = await writeTranscript(cursorHome, 'slug', 'chat-r', [
      JSON.stringify({ role: 'user', message: { content: 'one' } })
    ])
    resetSessionParseCacheForTests()
    await parseCursorCached(await cursorCandidate(cursorHome))

    await appendFile(
      transcriptPath,
      `${JSON.stringify({ role: 'user', message: { content: 'two' } })}\n`
    )
    failMetaJsonReads = true
    const { stats: refusedStats } = await parseCursorCached(await cursorCandidate(cursorHome))
    expect(refusedStats.incremental).toBe(1)

    failMetaJsonReads = false
    const { session, stats } = await parseCursorCached(await cursorCandidate(cursorHome))
    expect(stats.reused).toBe(1)
    expect(stats.fullParses).toBe(0)
    expect(session?.cwd).toBe('/repo/resume')
  })
})
