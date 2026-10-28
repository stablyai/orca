import { build } from 'esbuild'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { writeOpenCodeSqliteDatabase } from './session-scanner-opencode-sqlite-fixture'
import { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import { resolveOpenCodeSqliteWorkerEntryPath } from './session-scanner-opencode-sqlite-worker-spawn'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../shared/agent-session-host-status-rows'

const directory = mkdtempSync(join(tmpdir(), 'orca-opencode-native-worker-'))
const entry = resolveOpenCodeSqliteWorkerEntryPath(directory)
const v1Path = join(directory, 'v1', 'opencode.db')
const v2Path = join(directory, 'v2.db')

beforeAll(async () => {
  await build({
    entryPoints: ['src/main/foreign-sqlite-readers/foreign-sqlite-reader-entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    outfile: entry,
    logLevel: 'silent'
  })
  writeOpenCodeSqliteDatabase(v1Path, [
    {
      id: 'session',
      turns: ['first', 'second', 'third'].map((text) => ({ role: 'user', parts: [text] }))
    }
  ])
  const db = new SyncDatabase(v2Path)
  try {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT,
        seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);
      INSERT INTO session_v2 VALUES ('session');`)
    const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, 1, 1)')
    for (const [index, text] of ['first', 'second', 'third'].entries()) {
      insert.run(String(index), 'session', 'user', index + 1, JSON.stringify({ text }))
    }
  } finally {
    db.close()
  }
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('OpenCode reads through the production shared worker', () => {
  it.each(['v1-message', 'v1-part', 'v2-message'] as const)(
    'degrades %s oversize content through the actual worker and retains the next page',
    async (kind) => {
      const dbPath = join(directory, `${kind}.db`)
      const v2 = kind === 'v2-message'
      copyFileSync(v2 ? v2Path : v1Path, dbPath)
      const db = new SyncDatabase(dbPath)
      const table = v2 ? 'session_message' : kind === 'v1-part' ? 'part' : 'message'
      db.prepare(`UPDATE ${table} SET data = ?, time_updated = 2 WHERE rowid = 2`).run(
        JSON.stringify({ text: '😀'.repeat(600_000) })
      )
      db.close()
      const client = new OpenCodeSqliteWorkerClient({ workerFactory: () => new Worker(entry) })
      try {
        const args = { dbPath, sessionId: 'session', kind: 'native-page' as const, limit: 2 }
        const page = await client.readNativeChat(args)
        if (!page || !('items' in page)) {
          throw new Error('Expected the bounded native page')
        }
        expect(page.items.map((item) => item.rowid)).toEqual([2, 3])
        expect(page.items[0]?.message.role).toBe('system')
        expect(page.items[0]?.message.blocks).toEqual([
          {
            type: 'text',
            text: AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'],
            presentation: 'history-item-too-large'
          }
        ])
        const repeat = await client.readNativeChat(args)
        expect(repeat).toEqual(page)
        const older = await client.readNativeChat({
          ...args,
          beforeMessageRowId: page.beforeMessageRowId ?? undefined
        })
        expect(older).toMatchObject({ items: [{ rowid: 1 }], hasMore: false })
      } finally {
        client.dispose()
      }
    }
  )

  it.each([v1Path, v2Path])(
    'reads native signals and paginated history from %s',
    async (dbPath) => {
      const start = vi.fn(() => new Worker(entry))
      const client = new OpenCodeSqliteWorkerClient({ workerFactory: start })
      const args = { dbPath, sessionId: 'session' }
      try {
        await expect(
          client.readNativeChat({ ...args, kind: 'native-signal' })
        ).resolves.toMatchObject({
          messageCount: 3,
          maxMessageRowId: 3
        })
        const page = await client.readNativeChat({ ...args, kind: 'native-page', limit: 2 })
        if (!page || !('items' in page)) {
          throw new Error('Expected a native transcript page')
        }
        expect(page.items.map((item) => item.message.blocks)).toEqual([
          [{ type: 'text', text: 'second' }],
          [{ type: 'text', text: 'third' }]
        ])
        expect(page.hasMore).toBe(true)
        const older = await client.readNativeChat({
          ...args,
          kind: 'native-page',
          limit: 2,
          beforeMessageRowId: page.beforeMessageRowId ?? undefined
        })
        if (!older || !('items' in older)) {
          throw new Error('Expected the older transcript page')
        }
        expect(older.items.map((item) => item.message.blocks)).toEqual([
          [{ type: 'text', text: 'first' }]
        ])
        expect(older.hasMore).toBe(false)
        expect(start).toHaveBeenCalledOnce()
      } finally {
        client.dispose()
      }
    }
  )

  it('keeps list, parse and capture supported in the same worker', async () => {
    const start = vi.fn(() => new Worker(entry))
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: start })
    const issues: AiVaultScanIssue[] = []
    const args = { dbPath: v1Path, sessionId: 'session', platform: process.platform }
    try {
      expect(await client.list({ dbPaths: [v1Path], limit: 5, issues })).toHaveLength(1)
      expect(issues).toEqual([])
      expect(await client.parse(args)).toMatchObject({ sessionId: 'session' })
      expect((await client.capture(args)).messages.map((message) => message.text)).toEqual([
        'first',
        'second',
        'third'
      ])
      expect(start).toHaveBeenCalledOnce()
    } finally {
      client.dispose()
    }
  })
})
