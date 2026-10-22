import { link, mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { truncateAiVaultListResult } from '../../shared/ai-vault-session-depth'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { parseSessionCandidates } from './session-scanner-candidate-parse'
import {
  MAX_UNLISTED_ENTRIES,
  scopeCwdStampOf,
  peekSessionParseCacheEntry,
  setSessionParseCacheColdTier,
  type PersistedSessionParseCacheEntry,
  storeSessionParseCacheEntry,
  storeSessionScopeCwd,
  resetSessionParseCacheForTests
} from './session-parse-cache-store'
import { createSessionParseStats, parseAgentSessionFileCached } from './session-scanner-parse-cache'
import { scanAiVaultSessions } from './session-scanner'
import { createAntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { scanInScopeSessions } from './session-scanner-scope-walk'
import * as eventLoop from '../../shared/event-loop-yield'
import { AI_VAULT_SCOPE_CWD_SOURCES } from './session-scope-cwd'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import SyncDatabase from '../sqlite/sync-database'
import {
  initSessionParseCachePersistence,
  flushSessionParseCachePersist,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import {
  isolatedScanRoots,
  jsonLines,
  writeJsonlFile,
  writeAntigravityTranscript,
  writeAntigravityHistory
} from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetSessionParseCachePersistenceForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
  resetSessionParseCacheForTests()
})

it.each(['prefetch', 'read'] as const)('keeps an evicted parse from %s', async (boundary) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scope-publication-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const path = join(roots.codexSessionsDir, 'rollout-published.jsonl')
  await writeJsonlFile(path, [
    { type: 'session_meta', payload: { id: 'published', cwd: '/elsewhere' } },
    { type: 'turn_context', payload: { cwd: '/repo' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Find me' } }
  ])
  await utimes(path, 1, 1)
  await writeRollout(roots.codexSessionsDir, 'newer', '/other', '15')
  const { mtimeMs, size: sizeBytes, mtime } = await stat(path)
  const file = { path, mtimeMs, sizeBytes, modifiedAt: mtime.toISOString() }
  initSessionParseCachePersistence({ filePath: join(root, 'cache.json'), appVersion: 'test' })
  const metadata = vi.spyOn(SessionParseCacheDatabase.prototype, 'readScopeCwds')
  const publish = async () => {
    const parsed = await parseAgentSessionFileCached(
      { agent: 'codex', file, codexHome: null },
      'linux'
    )
    expect(parsed?.cwd).toBe('/repo')
    for (let index = 0; index <= MAX_UNLISTED_ENTRIES; index++) {
      storeSessionParseCacheEntry(`index-${index}`, {
        mtimeMs: mtimeMs + 1,
        sizeBytes: null,
        platform: 'linux',
        session: null,
        resume: null
      })
    }
    if (boundary === 'read') {
      await flushSessionParseCachePersist()
    }
    const db = new SyncDatabase(join(root, 'session-parse-cache.sqlite'))
    expect(db.prepare('SELECT path FROM rows WHERE path = ?').get(path) !== undefined).toBe(
      boundary === 'read'
    )
    db.close()
    metadata.mockClear()
  }
  if (boundary === 'prefetch') {
    storeSessionScopeCwd(path, { mtimeMs, sizeBytes, platform: 'linux', cwd: '/elsewhere' })
    vi.spyOn(eventLoop, 'yieldToEventLoop').mockImplementationOnce(publish)
  } else {
    const source = AI_VAULT_SCOPE_CWD_SOURCES.codex
    if (source.kind !== 'read') {
      throw new Error('Codex must have a cheap reader')
    }
    const original = source.readCwd
    vi.spyOn(source, 'readCwd').mockImplementation(async (candidate, signal) => {
      const read = await original(candidate, signal)
      if (candidate.file.path === path) {
        await publish()
      }
      return read
    })
  }
  const result = await scanAiVaultSessions({
    ...roots,
    platform: 'linux',
    limit: 1,
    scopePaths: ['/repo']
  })
  const found = result.sessions.filter((row) => row.filePath === path)
  expect(found.map((row) => row.cwd)).toEqual(['/repo'])
  expect(
    metadata.mock.calls.filter(([paths]) => paths.length === 1 && paths[0] === path)
  ).toHaveLength(1)
  expect(await stat(path)).toMatchObject({ mtimeMs, size: sizeBytes })
})

async function writeRollout(sessionsDir: string, id: string, cwd: string, day: string) {
  const dir = join(sessionsDir, '2026', '10', day)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `rollout-2026-10-${day}T10-00-00-${id}.jsonl`)
  const timestamp = `2026-10-${day}T10:00:00.000Z`
  await writeFile(
    path,
    jsonLines([
      // Codex's first record carries its base instructions, past the first 8 KB read.
      { timestamp, type: 'session_meta', payload: { id, cwd, instructions: 'x'.repeat(20_000) } },
      {
        timestamp,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: id }] }
      }
    ])
  )
  await utimes(path, new Date(timestamp), new Date(timestamp))
  return path
}

describe('scanAiVaultSessions — scope before the recency cap', () => {
  it('lists an older in-scope Codex session once across hardlinked homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-walk-'))
    tempRoots.push(root)
    const realHome = join(root, 'real-codex-home')
    const managedSessionsDir = join(root, 'codex-accounts', 'a1', 'home', 'sessions')
    const workspace = '/Users/ada/orca/workspaces/orca/taimen-2'

    const old = await writeRollout(managedSessionsDir, '01a14083-old', workspace, '11')
    await mkdir(join(realHome, 'sessions', '2026', '10', '11'), { recursive: true })
    await link(old, old.replace(managedSessionsDir, join(realHome, 'sessions')))
    for (const [index, day] of ['13', '14', '15'].entries()) {
      await writeRollout(managedSessionsDir, `02b-newer-${index}`, '/Users/ada/other', day)
    }

    const scan = (scopePaths?: string[]) =>
      scanAiVaultSessions({
        ...isolatedScanRoots(root),
        codexSessionsDir: join(realHome, 'sessions'),
        defaultCodexHomeDir: realHome,
        additionalCodexSessionsDirs: [managedSessionsDir],
        platform: 'darwin',
        limit: 2,
        scopePaths
      })

    expect((await scan()).sessions.map((session) => session.sessionId)).not.toContain(
      '01a14083-old'
    )
    const scoped = await scan([workspace])
    const inScope = scoped.sessions.filter((session) => session.cwd === workspace)
    expect(inScope.map((session) => session.sessionId)).toEqual(['01a14083-old'])
    // The host's cached list is cut by the same scope rule, so the recovered row survives it.
    expect(
      truncateAiVaultListResult(scoped, 2, [workspace]).sessions.map((s) => s.sessionId)
    ).toContain('01a14083-old')
  })
})

it('keeps an older Antigravity session in scope across warm scans and changed history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scope-history-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  await writeRollout(roots.codexSessionsDir, 'newer', '/other', '15')
  const timestamp = '2026-10-11T10:00:00.000Z'
  const path = await writeAntigravityTranscript(roots.antigravityBrainDir, 'older', [
    { source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: timestamp, content: 'Find me' }
  ])
  await utimes(path, new Date(timestamp), new Date(timestamp))
  const history = (workspace: string) =>
    writeAntigravityHistory(roots.antigravityBrainDir, [
      { conversationId: 'older', display: 'Find me', timestamp, workspace }
    ])
  const scan = () =>
    scanAiVaultSessions({ ...roots, platform: 'linux', limit: 1, scopePaths: ['/repo'] })
  await history('/repo')
  expect((await scan()).sessions.map((row) => row.sessionId)).toContain('older')
  expect((await scan()).sessions.map((row) => row.sessionId)).toContain('older')
  await history('/elsewhere')
  expect((await scan()).sessions.map((row) => row.sessionId)).not.toContain('older')
  await history('/repo')
  expect((await scan()).sessions.map((row) => row.sessionId)).toContain('older')
})

it('admits the newest scoped activity when copied Hermes files have newer mtimes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scope-activity-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  await writeRollout(roots.codexSessionsDir, 'newer', '/other', '15')
  await mkdir(roots.hermesSessionsDir, { recursive: true })
  const base = Date.parse('2026-10-10T00:00:00.000Z')
  for (let index = 0; index < 17; index++) {
    const path = join(roots.hermesSessionsDir, `session_${index}.json`)
    await writeFile(
      path,
      JSON.stringify({
        session_id: `hermes-${index}`,
        cwd: '/repo',
        message_count: 1,
        last_updated: new Date(base + (index === 16 ? 980 : 100)).toISOString()
      })
    )
    await utimes(path, new Date(base + 1000 - index), new Date(base + 1000 - index))
  }
  const scan = (limit: number) =>
    scanAiVaultSessions({ ...roots, platform: 'linux', limit, scopePaths: ['/repo'] })
  const result = await scan(1)
  expect(result.sessions.filter((row) => row.cwd === '/repo').map((row) => row.sessionId)).toEqual([
    'hermes-16'
  ])
  expect(result.sessions.some((row) => row.sessionId === 'newer')).toBe(true)
  expect(
    truncateAiVaultListResult(result, 1, ['/repo'])
      .sessions.filter((row) => row.cwd === '/repo')
      .map((row) => row.sessionId)
  ).toEqual(['hermes-16'])
  const deeper = await scan(2)
  const scopedIds = (rows: AiVaultListResult) =>
    rows.sessions.filter((row) => row.cwd === '/repo').map((row) => row.sessionId)
  expect(scopedIds(deeper)[0]).toBe('hermes-16')
  // A deeper cached scan serving depth 1 keeps every scoped row it found.
  expect(scopedIds(truncateAiVaultListResult(deeper, 1, ['/repo']))).toEqual(scopedIds(deeper))
})

it('delivers cancellation while traversing unchanged cached candidates', async () => {
  const candidates = Array.from({ length: 512 }, (_, index) => {
    const file = {
      path: `/cached/${index}.json`,
      mtimeMs: 1,
      modifiedAt: new Date(1).toISOString()
    }
    storeSessionParseCacheEntry(file.path, {
      mtimeMs: 1,
      sizeBytes: null,
      platform: 'linux',
      session: null,
      resume: null
    })
    return { agent: 'hermes' as const, file, codexHome: null }
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 0)
  try {
    await expect(
      parseSessionCandidates({
        candidates,
        limit: 1,
        platform: 'linux',
        executionHostId: 'local',
        issues: [],
        parseStats: createSessionParseStats(),
        signal: controller.signal,
        listed: false,
        selectCandidate: async () => true
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    clearTimeout(timer)
  }
})

it('uses a cold parsed latest Codex cwd after its unlisted row is evicted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scope-cold-cwd-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const path = join(roots.codexSessionsDir, 'rollout-cold-cwd.jsonl')
  const content = [{ type: 'text', text: 'Find me' }]
  await writeJsonlFile(path, [
    { type: 'session_meta', payload: { id: 'cold-cwd', cwd: '/elsewhere' } },
    { type: 'turn_context', payload: { cwd: '/repo' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content } }
  ])
  await utimes(path, 1, 1)
  for (const day of ['14', '15']) {
    await writeRollout(roots.codexSessionsDir, `busy-${day}`, '/elsewhere', day)
  }
  const { mtimeMs, size: sizeBytes, mtime } = await stat(path)
  const file = { path, mtimeMs, sizeBytes, modifiedAt: mtime.toISOString() }
  const rows = new Map<string, PersistedSessionParseCacheEntry>()
  const read = vi.fn((key: string) => rows.get(key))
  setSessionParseCacheColdTier({
    read,
    readScopeCwds: (paths) => ({
      found: new Map(
        paths.flatMap((key) => {
          const row = rows.get(key)
          return row === undefined ? [] : [[key, { parsed: scopeCwdStampOf(row) }] as const]
        })
      ),
      parsed: true,
      read: true
    }),
    stored: (key, row) => rows.set(key, row),
    deleted: (key) => rows.delete(key)
  })
  const scan = () =>
    scanAiVaultSessions({ ...roots, platform: 'linux', limit: 1, scopePaths: ['/repo'] })
  expect((await scan()).sessions.some((row) => row.filePath === path)).toBe(false)
  const parsed = await parseAgentSessionFileCached(
    { agent: 'codex', file, codexHome: null },
    'linux'
  )
  expect(rows.get(path)?.session?.cwd).toBe('/repo')
  for (let index = 0; index <= MAX_UNLISTED_ENTRIES; index++) {
    storeSessionParseCacheEntry(`search-${index}`, {
      mtimeMs: mtimeMs + 1,
      sizeBytes: null,
      platform: 'linux',
      session: null,
      resume: null
    })
  }
  expect(peekSessionParseCacheEntry(path)).not.toHaveProperty('resume')
  read.mockClear()
  const found = (await scan()).sessions.filter((row) => row.filePath === path)
  expect(found.map((row) => row.cwd)).toEqual(['/repo'])
  expect(read).toHaveBeenCalledWith(path)
  expect(peekSessionParseCacheEntry(path)?.session).toBe(parsed)
  expect(await stat(path)).toMatchObject({ mtimeMs, size: sizeBytes })
})

it('walks a history larger than the spread-argument limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scope-huge-'))
  tempRoots.push(root)
  const sessionsDir = join(root, 'sessions')
  const path = await writeRollout(sessionsDir, 'huge-history', '/repo', '15')
  const { mtimeMs, mtime } = await stat(path)
  const older = Array.from({ length: 200_000 }, (_, index) => ({
    path: join(sessionsDir, `rollout-old-${index}.jsonl`),
    mtimeMs: 1,
    modifiedAt: new Date(1).toISOString()
  }))
  const sessions = await scanInScopeSessions({
    inventory: [],
    discoveries: [
      {
        agent: 'codex',
        rootDir: sessionsDir,
        files: [{ path, mtimeMs, modifiedAt: mtime.toISOString() }],
        scopeFiles: older
      }
    ],
    options: { scopePaths: ['/repo'] },
    limit: 1,
    alreadyParsedFilePaths: new Set(),
    platform: 'linux',
    executionHostId: 'local',
    issues: [],
    parseStats: createSessionParseStats(),
    antigravityWorkspaceResolver: createAntigravityWorkspaceResolver(async () => null)
  })
  expect(sessions.map((session) => session.sessionId)).toEqual(['huge-history'])
})
