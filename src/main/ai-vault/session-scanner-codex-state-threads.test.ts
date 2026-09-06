import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { parseCodexSessionFile } from './session-scanner-codex-parser'
import {
  readCodexStateThreadMetadata,
  resetCodexStateThreadCacheForTests
} from './session-scanner-codex-state-threads'
import type { FileWithMtime } from './session-scanner-types'

// Pins the real Codex `threads` schema this module reads (state_5.sqlite, 2026-09).
const CREATE_THREADS_TABLE = `CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  rollout_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  cwd TEXT NOT NULL,
  title TEXT NOT NULL,
  sandbox_policy TEXT NOT NULL,
  approval_mode TEXT NOT NULL,
  git_sha TEXT,
  git_branch TEXT,
  git_origin_url TEXT,
  name TEXT,
  preview TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER,
  updated_at_ms INTEGER
)`

const INSERT_THREAD = `INSERT INTO threads (
  id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
  sandbox_policy, approval_mode, git_branch, name, created_at_ms, updated_at_ms
) VALUES (?, ?, ?, ?, 'cli', 'openai', ?, ?, 'workspace-write', 'on-request', ?, ?, ?, ?)`

type ThreadRow = {
  id: string
  cwd: string
  title: string
  branch: string | null
  name: string | null
}

let tempRoots: string[] = []

afterEach(async () => {
  resetCodexStateThreadCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function createCodexHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-state-threads-'))
  tempRoots.push(root)
  const codexHome = join(root, 'codex-home')
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  return codexHome
}

function writeStateDb(codexHome: string, rows: ThreadRow[], version = 5): string {
  const stateDbPath = join(codexHome, `state_${version}.sqlite`)
  const db = new SyncDatabase(stateDbPath)
  db.exec('PRAGMA journal_mode = DELETE')
  db.exec(CREATE_THREADS_TABLE)
  const insert = db.prepare(INSERT_THREAD)
  for (const row of rows) {
    insert.run(
      row.id,
      join(codexHome, 'sessions', `rollout-${row.id}.jsonl`),
      1_788_000_000,
      1_788_000_600,
      row.cwd,
      row.title,
      row.branch,
      row.name,
      1_788_000_000_000,
      1_788_000_600_000
    )
  }
  db.close()
  return stateDbPath
}

describe('codex state db thread metadata', () => {
  it('reads title, cwd, branch and updatedAt from the newest state db', async () => {
    const codexHome = await createCodexHome()
    writeStateDb(codexHome, [
      { id: 'old', cwd: '/old', title: 'old first message', branch: 'old', name: null }
    ])
    writeStateDb(
      codexHome,
      [
        {
          id: 'thread-1',
          cwd: '/repo/main',
          title: 'the whole first user message, long',
          branch: 'feature/state-db',
          name: 'Named Thread'
        }
      ],
      6
    )

    const metadata = await readCodexStateThreadMetadata(codexHome, 'thread-1')

    expect(metadata).toEqual({
      title: 'Named Thread',
      cwd: '/repo/main',
      branch: 'feature/state-db',
      updatedAt: new Date(1_788_000_600_000).toISOString()
    })
    // Only the newest state_N.sqlite is consulted.
    expect(await readCodexStateThreadMetadata(codexHome, 'old')).toBeNull()
  })

  it('falls back to the first-message title column when the thread is unnamed', async () => {
    const codexHome = await createCodexHome()
    writeStateDb(codexHome, [
      { id: 'thread-2', cwd: '/repo/two', title: 'implement the thing', branch: null, name: '  ' }
    ])

    const metadata = await readCodexStateThreadMetadata(codexHome, 'thread-2')

    expect(metadata?.title).toBe('implement the thing')
    expect(metadata?.branch).toBeNull()
  })

  it('re-reads the state db after its mtime changes', async () => {
    const codexHome = await createCodexHome()
    const stateDbPath = writeStateDb(codexHome, [
      { id: 'thread-3', cwd: '/repo/before', title: 'before', branch: 'before', name: null }
    ])

    expect((await readCodexStateThreadMetadata(codexHome, 'thread-3'))?.cwd).toBe('/repo/before')

    const db = new SyncDatabase(stateDbPath)
    db.exec("UPDATE threads SET cwd = '/repo/after' WHERE id = 'thread-3'")
    db.close()
    const future = new Date(Date.now() + 5_000)
    await utimes(stateDbPath, future, future)

    expect((await readCodexStateThreadMetadata(codexHome, 'thread-3'))?.cwd).toBe('/repo/after')
  })

  it('serves repeat reads from the signature cache while the db is unchanged', async () => {
    const codexHome = await createCodexHome()
    const stateDbPath = writeStateDb(codexHome, [
      { id: 'thread-4', cwd: '/repo/cached', title: 'cached', branch: null, name: null }
    ])

    // Pin to whole milliseconds so restoring it after the edit reproduces the signature exactly.
    const pinned = new Date(1_788_000_000_000)
    await utimes(stateDbPath, pinned, pinned)

    expect((await readCodexStateThreadMetadata(codexHome, 'thread-4'))?.cwd).toBe('/repo/cached')

    const db = new SyncDatabase(stateDbPath)
    db.exec("UPDATE threads SET cwd = '/repo/edited' WHERE id = 'thread-4'")
    db.close()
    await utimes(stateDbPath, pinned, pinned)

    // Same size and mtime, so the edit is invisible and the cached map answers.
    expect((await readCodexStateThreadMetadata(codexHome, 'thread-4'))?.cwd).toBe('/repo/cached')
  })

  it('yields no metadata and does not throw when the state db is missing', async () => {
    const codexHome = await createCodexHome()

    await expect(readCodexStateThreadMetadata(codexHome, 'thread-5')).resolves.toBeNull()
    await expect(readCodexStateThreadMetadata(null, 'thread-5')).resolves.toBeNull()
  })

  it('yields no metadata and does not throw when the state db is unreadable', async () => {
    const codexHome = await createCodexHome()
    await writeFile(join(codexHome, 'state_5.sqlite'), 'not a sqlite database at all')

    await expect(readCodexStateThreadMetadata(codexHome, 'thread-6')).resolves.toBeNull()
  })

  it('yields no metadata and does not throw while another writer holds the db locked', async () => {
    const codexHome = await createCodexHome()
    const stateDbPath = writeStateDb(codexHome, [
      { id: 'thread-7', cwd: '/repo/locked', title: 'locked', branch: null, name: null }
    ])
    const writer = new SyncDatabase(stateDbPath)
    writer.exec('PRAGMA journal_mode = DELETE')
    writer.exec('BEGIN EXCLUSIVE')
    writer.exec("UPDATE threads SET cwd = '/repo/locked-2' WHERE id = 'thread-7'")

    try {
      await expect(readCodexStateThreadMetadata(codexHome, 'thread-7')).resolves.toBeNull()
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
  })
})

describe('codex parser state db fallback', () => {
  async function writeRollout(codexHome: string, threadId: string, lines: string): Promise<string> {
    const path = join(codexHome, 'sessions', `rollout-${threadId}.jsonl`)
    await writeFile(path, lines)
    return path
  }

  function fileWithMtime(path: string): FileWithMtime {
    return { path, mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
  }

  it('fills title, cwd and branch when the rollout records none', async () => {
    const codexHome = await createCodexHome()
    writeStateDb(codexHome, [
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        cwd: '/repo/from-state-db',
        title: 'first message from state db',
        branch: 'state-db-branch',
        name: null
      }
    ])
    const rolloutPath = await writeRollout(
      codexHome,
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } })}\n`
    )

    const session = await parseCodexSessionFile(
      fileWithMtime(rolloutPath),
      'darwin',
      codexHome,
      undefined
    )

    expect(session?.cwd).toBe('/repo/from-state-db')
    expect(session?.branch).toBe('state-db-branch')
    expect(session?.title).toBe('first message from state db')
  })

  it('keeps the rollout cwd and branch over the state db', async () => {
    const codexHome = await createCodexHome()
    writeStateDb(codexHome, [
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
        cwd: '/repo/from-state-db',
        title: 'state db title',
        branch: 'state-db-branch',
        name: null
      }
    ])
    const rolloutPath = await writeRollout(
      codexHome,
      'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
          cwd: '/repo/from-rollout',
          git: { branch: 'rollout-branch' }
        }
      })}\n`
    )

    const session = await parseCodexSessionFile(fileWithMtime(rolloutPath), 'darwin', codexHome)

    expect(session?.cwd).toBe('/repo/from-rollout')
    expect(session?.branch).toBe('rollout-branch')
  })
})
