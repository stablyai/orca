import { link, mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { truncateAiVaultListResult } from '../../shared/ai-vault/scanning/ai-vault-session-depth'

import { parseSessionCandidates } from './session-scanner-candidate-parse'
import {
  MAX_UNLISTED_ENTRIES,
  storeSessionParseCacheEntry,
  storeSessionScopeCwd,
  resetSessionParseCacheForTests
} from './parse-cache/session-parse-cache-store'
import {
  createSessionParseStats,
  parseAgentSessionFileCached
} from './parse-cache/session-scanner-parse-cache'
import { scanAiVaultSessions } from './session-scanner'

import * as eventLoop from '../../shared/event-loop-yield'
import { AI_VAULT_SCOPE_CWD_SOURCES } from './session-scope-cwd'
import { SessionParseCacheDatabase } from './parse-cache/session-parse-cache-database'
import SyncDatabase from '../sqlite/sync-database'
import {
  initSessionParseCachePersistence,
  flushSessionParseCachePersist,
  resetSessionParseCachePersistenceForTests
} from './parse-cache/session-parse-cache-persistence'
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
      // Large Codex headers must still expose cwd beyond the initial read chunk.
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
