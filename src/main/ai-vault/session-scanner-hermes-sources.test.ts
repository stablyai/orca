import { build } from 'esbuild'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { createOpenCodeSqliteProcessClient } from './session-scanner-opencode-sqlite-process-client'
import { HERMES_SCHEMA_31 } from './session-scanner-hermes-sqlite-fixtures'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import * as wslReaders from './session-scanner-opencode-wsl-client'
import { parseWslUncPath } from '../../shared/wsl-paths'
import * as workerSpawn from './session-scanner-opencode-sqlite-worker-spawn'
import type { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import { hermesStoreHomes } from './session-scanner-hermes-stores'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { resetSessionParseCacheForTests } from './session-parse-cache-store'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { buildHermesSqliteCandidatePath } from './session-scanner-hermes-sqlite-paths'
import { listHermesSqliteSessionsViaWorker } from './session-scanner-hermes-worker'
import { readAiVaultFirstUserPrompt } from './session-first-user-prompt-read'

let root: string
let client: OpenCodeSqliteWorkerClient
const writers: Database.Database[] = []
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-hermes-stores-'))
  const entry = join(root, 'reader.cjs')
  await build({
    entryPoints: ['src/main/ai-vault/session-scanner-opencode-sqlite-process-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: entry,
    logLevel: 'silent'
  })
  client = createOpenCodeSqliteProcessClient({
    executable: process.execPath,
    args: [entry],
    cwd: root
  })
  vi.spyOn(workerSpawn, 'getSharedSqliteReaderClient').mockReturnValue(client)
})
afterAll(async () => {
  client?.dispose()
  for (const db of writers) {
    db.close()
  }
  vi.restoreAllMocks()
  resetSessionParseCacheForTests()
  await rm(root, { recursive: true, force: true })
})

async function store(
  home: string,
  records: {
    id: string
    title?: string
    time?: number
    cwd?: string
    empty?: boolean
    hidden?: boolean
  }[]
) {
  await mkdir(home, { recursive: true })
  const db = new Database(join(home, 'state.db'))
  writers.push(db)
  db.exec(HERMES_SCHEMA_31)
  db.pragma('journal_mode = WAL')
  db.pragma('wal_autocheckpoint = 0')
  for (const record of records) {
    db.prepare(
      'INSERT INTO sessions(id,source,started_at,last_activity_at,cwd,title,hidden) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      record.id,
      'cli',
      record.time ?? 1800000000,
      record.time ?? 1800000000,
      record.cwd ?? '/workspace',
      record.title ?? record.id,
      record.hidden ? 1 : 0
    )
    if (!record.empty) {
      db.prepare('INSERT INTO messages(session_id,role,content,timestamp) VALUES (?, ?, ?, ?)').run(
        record.id,
        'user',
        record.title ?? record.id,
        record.time ?? 1800000000
      )
    }
  }
}
async function legacy(home: string, id: string, title = id) {
  await mkdir(join(home, 'sessions'), { recursive: true })
  await writeFile(
    join(home, 'sessions', `session_${id}.json`),
    JSON.stringify({
      session_id: id,
      session_start: '2027-01-15T08:00:00Z',
      cwd: '/workspace',
      messages: [{ role: 'user', content: title }]
    })
  )
}
function options(home: string, extra = {}) {
  return {
    ...isolatedScanRoots(root),
    hermesSessionsDir: join(home, 'sessions'),
    hermesStateDbPaths: undefined,
    wslHomeDirs: [],
    limit: 30,
    ...extra
  }
}

describe('Hermes store discovery through the deployed SQLite reader', () => {
  it('discovers default and named stores with equal IDs and pins their resume sources', async () => {
    const home = join(root, 'profiles-case')
    await store(home, [{ id: 'same', title: 'Default store' }])
    await store(join(home, 'profiles', 'win-admin'), [{ id: 'same', title: 'Named store' }])
    const result = await scanAiVaultSessions(options(home))
    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(2)
    expect(new Set(result.sessions.map((s) => s.id)).size).toBe(2)
    expect(result.sessions.find((s) => s.title === 'Default store')?.resumeCommand).toContain(
      "--profile 'default'"
    )
    expect(result.sessions.find((s) => s.title === 'Named store')?.resumeCommand).toContain(
      "--profile 'win-admin'"
    )
  })
  it('deduplicates within each store beyond the recency cap and keeps migration shells and other homes', async () => {
    const home = join(root, 'dedup-case')
    await store(home, [
      { id: 'recent', time: 1900000000 },
      { id: 'older', time: 1700000000 },
      { id: 'shell', empty: true },
      { id: 'hidden', hidden: true }
    ])
    await legacy(home, 'older', 'Stale snapshot')
    await legacy(home, 'shell', 'Keep migration messages')
    await legacy(home, 'hidden', 'Hidden stale snapshot')
    const profile = join(home, 'profiles', 'coder')
    await store(profile, [{ id: 'same' }])
    await legacy(home, 'same', 'Different home')
    const result = await scanAiVaultSessions(options(home, { limit: 10, limitPerAgent: 10 }))
    expect(result.issues).toEqual([])
    expect(result.sessions.filter((s) => s.sessionId === 'older')).toHaveLength(1)
    expect(result.sessions.find((s) => s.sessionId === 'older')?.filePath).toContain(
      'state.db#older'
    )
    expect(result.sessions.find((s) => s.sessionId === 'shell')?.title).toBe(
      'Keep migration messages'
    )
    expect(result.sessions.filter((s) => s.sessionId === 'same')).toHaveLength(2)
    expect(result.sessions.some((s) => s.sessionId === 'hidden')).toBe(false)
    const represented: string[] = []
    await listHermesSqliteSessionsViaWorker({
      dbPaths: [join(home, 'state.db')],
      limit: 1,
      issues: [],
      legacySessionIds: ['older'],
      onRepresentedSessionIds: (ids) => represented.push(...ids)
    })
    expect(represented).toEqual(['older'])
  })
  it('finds older scoped rows before the global recency limit', async () => {
    const home = join(root, 'scope-case')
    await store(home, [
      { id: 'new', time: 1900000000, cwd: '/unrelated' },
      { id: 'old', time: 1700000000, cwd: '/workspace/subdir' }
    ])
    const result = await scanAiVaultSessions(
      options(home, { limit: 1, limitPerAgent: 1, scopePaths: ['/workspace'] })
    )
    expect(result.sessions.map((s) => s.sessionId)).toContain('old')
  })
  it('skips tombstoned and invalid profile directories and bounds store enumeration', async () => {
    const home = join(root, 'prune-case')
    await store(home, [])
    await store(join(home, 'profiles', 'live'), [{ id: 'live' }])
    await store(join(home, 'profiles', 'deleted'), [{ id: 'deleted' }])
    await store(join(home, 'profiles', '.hidden'), [{ id: 'dot' }])
    await store(join(home, 'profiles', 'Bad Name'), [{ id: 'invalid' }])
    await mkdir(join(home, 'profiles', '.deleted'), { recursive: true })
    await writeFile(join(home, 'profiles', '.deleted', 'deleted'), 'deleted')
    const issues: AiVaultScanIssue[] = []
    const homes = await hermesStoreHomes(options(home), [], issues)
    expect(homes).toEqual([home, join(home, 'profiles', 'live')])
    expect(issues).toEqual([])
  })
  it('preserves displaced in-scope legacy rows across profile budgets', async () => {
    const home = join(root, 'legacy-scope-case')
    await store(home, [])
    const profile = join(home, 'profiles', 'work')
    await store(profile, [])
    await legacy(home, 'outside')
    await legacy(profile, 'inside')
    await writeFile(
      join(home, 'sessions', 'session_outside.json'),
      JSON.stringify({
        session_id: 'outside',
        cwd: '/elsewhere',
        messages: [{ role: 'user', content: 'outside' }]
      })
    )
    const result = await scanAiVaultSessions(
      options(home, { limit: 1, limitPerAgent: 1, scopePaths: ['/workspace'] })
    )
    expect(result.sessions.map((session) => session.sessionId)).toContain('inside')
  })
  it('decodes delimiter IDs and forwards full-prompt mode through the production worker route', async () => {
    const home = join(root, 'delimiter-case')
    const prompt = 'A complete first prompt. '.repeat(200)
    const id = 'same#id%'
    await store(home, [{ id, title: prompt }])
    const path = buildHermesSqliteCandidatePath(join(home, 'state.db'), id)
    const candidate = {
      agent: 'hermes' as const,
      codexHome: null,
      file: { path, mtimeMs: 1800000000000, modifiedAt: '2027-01-15T08:00:00Z' }
    }
    const parsed = await withFullFirstUserPromptCapture(() =>
      parseAgentSessionFile(candidate, 'linux')
    )
    expect(parsed?.sessionId).toBe(id)
    expect(parsed?.firstUserPrompt).toBe(prompt.trim())
    expect(parsed?.resumeCommand).toContain("--resume 'same#id%'")
    expect(await readAiVaultFirstUserPrompt({ agent: 'hermes', filePath: path })).toEqual({
      prompt: prompt.trim()
    })
  })
  it('routes WSL SQLite through the guest reader and preserves the encoded source path', async () => {
    const home = join(root, 'guest-case', 'profiles', 'work')
    const id = 'guest#id%'
    await store(home, [{ id }])
    const dbPath = `\\\\wsl.localhost\\Ubuntu${join(home, 'state.db').replace(/\//g, '\\')}`
    const guest = vi.spyOn(wslReaders, 'openCodeWslPath').mockImplementation(parseWslUncPath)
    const reader = vi.spyOn(wslReaders, 'openCodeWslClient').mockResolvedValue(client)
    try {
      const issues: AiVaultScanIssue[] = []
      const candidates = await listHermesSqliteSessionsViaWorker({
        dbPaths: [dbPath],
        limit: 5,
        issues
      })
      expect(issues).toEqual([])
      expect(candidates[0]?.file.path).toBe(buildHermesSqliteCandidatePath(dbPath, id))
      const session = await parseAgentSessionFile(candidates[0], 'win32')
      expect(session?.filePath).toBe(buildHermesSqliteCandidatePath(dbPath, id))
      expect(session?.sessionId).toBe(id)
      expect(session?.executionHostPlatform).toBe('linux')
      expect(session?.resumeCommand).toContain("--profile 'work'")
      reader.mockRejectedValueOnce(new Error('The WSL SQLite reader is not prepared.'))
      expect(
        await listHermesSqliteSessionsViaWorker({ dbPaths: [dbPath], limit: 5, issues })
      ).toEqual([])
      expect(issues).toEqual([
        expect.objectContaining({ agent: 'hermes', kind: 'scope', path: dbPath })
      ])
    } finally {
      guest.mockRestore()
      reader.mockRestore()
    }
  })
  it('does not begin a database read after cancellation', async () => {
    const abort = new AbortController()
    abort.abort(new Error('superseded'))
    await expect(
      scanAiVaultSessions(options(join(root, 'cancel'), { signal: abort.signal }))
    ).rejects.toThrow()
  })
})
