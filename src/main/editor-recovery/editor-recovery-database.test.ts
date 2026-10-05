import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { EditorRecoveryDatabase } from './editor-recovery-database'
import type { EditorRecoveryChange, EditorRecoveryMetadata } from '../../shared/editor-recovery'
import { createEditorRecoveryTextPatch } from '../../shared/editor-recovery-text-patch'
import { EDITOR_RECOVERY_PATCH_LIMIT } from './editor-recovery-draft-bodies'
import { editorRecoveryResourceKey } from '../../shared/editor-recovery'

const roots: string[] = []
const databases = new Set<EditorRecoveryDatabase>()
afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases) {
    database.close()
  }
  databases.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-editor-recovery-'))
  roots.push(root)
  const path = join(root, 'recovery.sqlite')
  const open = () => {
    const database = new EditorRecoveryDatabase(path)
    databases.add(database)
    return database
  }
  return { root, path, open }
}
function metadata(overrides: Partial<EditorRecoveryMetadata> = {}): EditorRecoveryMetadata {
  return {
    hostId: 'local',
    worktreeId: 'folder:one',
    filePath: '/same/note.txt',
    relativePath: 'note.txt',
    language: 'plaintext',
    bufferKind: 'edit',
    lastKnownDiskSignature: 'original-disk',
    ...overrides
  }
}
function put(
  id: string,
  content: string,
  expectedRevision = 0,
  owner = metadata()
): EditorRecoveryChange {
  return { kind: 'put', id, content, expectedRevision, metadata: owner, state: 'active' }
}

describe('durable editor recovery journal', () => {
  it('round-trips empty, Unicode and large drafts with separate host and surface identities', () => {
    const f = fixture()
    const database = f.open()
    const text = 'line\0😀\ud800\udc00\ud800\r\n'.repeat(100_000)
    const owners = [
      metadata(),
      metadata({ hostId: 'ssh:one' }),
      metadata({ hostId: 'runtime:one', runtimeEnvironmentId: 'one' }),
      metadata({ bufferKind: 'diff' })
    ]
    expect(
      database.apply(
        owners.map((owner, index) => put(`buffer-${index}`, index === 0 ? '' : text, 0, owner))
      )
    ).toEqual(owners.map((_, index) => ({ id: `buffer-${index}`, revision: 1 })))
    database.close()
    databases.delete(database)
    const reopened = f.open()
    expect(reopened.list()).toHaveLength(4)
    expect(reopened.list()[0]).not.toHaveProperty('content')
    for (const [index, owner] of owners.entries()) {
      expect(reopened.latestActive(owner)).toMatchObject({
        id: `buffer-${index}`,
        content: index === 0 ? '' : text,
        lastKnownDiskSignature: 'original-disk',
        revision: 1
      })
    }
  })

  it('retains a closed buffer and fences stale saves, discarded imports and delayed writes', () => {
    const database = fixture().open()
    database.importLegacy([{ metadata: metadata(), content: 'unsaved legacy text' }])
    const imported = database.list()[0]
    if (!imported) {
      throw new Error('Migration did not retain the draft')
    }
    expect(database.apply([{ kind: 'retain', id: imported.id, expectedRevision: 1 }])).toEqual([
      { id: imported.id, revision: 2 }
    ])
    expect(database.latestActive(metadata())).toBeNull()
    expect(database.read(imported.id)?.content).toBe('unsaved legacy text')
    expect(database.apply([{ kind: 'resolve', id: imported.id, expectedRevision: 1 }])).toEqual([
      { id: imported.id, revision: null }
    ])
    expect(database.apply([put(imported.id, 'stale content', 1)])).toEqual([
      { id: imported.id, revision: null }
    ])
    expect(database.apply([{ kind: 'resolve', id: imported.id, expectedRevision: 2 }])).toEqual([
      { id: imported.id, revision: 3 }
    ])
    database.importLegacy([{ metadata: metadata(), content: 'unsaved legacy text' }])
    expect(database.apply([put(imported.id, 'late creation', 0)])).toEqual([
      { id: imported.id, revision: null }
    ])
    expect(database.list()).toEqual([])
    expect(database.read(imported.id)).toBeNull()
  })

  it('imports idempotently without replacing a newer journal checkpoint', () => {
    const database = fixture().open()
    database.apply([put('current', 'new text')])
    for (let index = 0; index < 3; index++) {
      database.importLegacy([{ metadata: metadata(), content: 'older text' }])
    }
    expect(database.list()).toHaveLength(2)
    expect(database.latestActive(metadata())?.content).toBe('new text')
    expect(database.list().find((entry) => entry.id.startsWith('legacy:'))?.updatedAt).toBe(0)
  })

  it('retires an ID before its first write and preserves distinct unfinished Unicode drafts during migration', () => {
    const database = fixture().open()
    expect(database.apply([{ kind: 'resolve', id: 'saved-first', expectedRevision: 0 }])).toEqual([
      { id: 'saved-first', revision: 1 }
    ])
    expect(database.apply([put('saved-first', 'delayed content', 0)])).toEqual([
      { id: 'saved-first', revision: null }
    ])
    expect(database.status(['saved-first'])).toEqual([
      { id: 'saved-first', revision: 1, state: 'resolved' }
    ])
    database.importLegacy([
      { metadata: metadata(), content: '\ud800' },
      { metadata: metadata(), content: '\ud801' }
    ])
    expect(database.list()).toHaveLength(2)
    expect(new Set(database.list().map((entry) => database.read(entry.id)?.content))).toEqual(
      new Set(['\ud800', '\ud801'])
    )
  })

  it('rolls back every row when a commit fails, then accepts the same pending checkpoint', () => {
    const database = fixture().open()
    database.apply([put('one', 'original')])
    const originalExec = SyncDatabase.prototype.exec
    const fault = vi.spyOn(SyncDatabase.prototype, 'exec').mockImplementation(function (
      this: SyncDatabase,
      sql: string
    ) {
      if (sql === 'COMMIT') {
        throw new Error('disk commit failed')
      }
      originalExec.call(this, sql)
    })
    expect(() => database.apply([put('one', 'changed', 1), put('two', 'second')])).toThrow(
      'disk commit failed'
    )
    expect(database.read('one')).toMatchObject({ content: 'original', revision: 1 })
    expect(database.read('two')).toBeNull()
    fault.mockRestore()
    expect(database.apply([put('one', 'changed', 1), put('two', 'second')])).toEqual([
      { id: 'one', revision: 2 },
      { id: 'two', revision: 1 }
    ])
  })

  it('preserves corrupt and newer journals instead of replacing them with an empty database', () => {
    const f = fixture()
    writeFileSync(f.path, 'irreplaceable damaged journal')
    const corrupt = readFileSync(f.path)
    expect(() => f.open()).toThrow()
    expect(readFileSync(f.path)).toEqual(corrupt)
    rmSync(f.path)
    const newer = new SyncDatabase(f.path)
    newer.exec(
      "CREATE TABLE future_drafts(content TEXT); INSERT INTO future_drafts VALUES ('future text'); PRAGMA user_version = 3"
    )
    newer.close()
    const bytes = readFileSync(f.path)
    expect(() => f.open()).toThrow('newer application version')
    expect(readFileSync(f.path)).toEqual(bytes)
  })

  it('bounds patch replay, compacts atomically and recovers exact text after reopening', () => {
    const f = fixture()
    const database = f.open()
    const original = 'line\0😀\ud800\r\n'.repeat(1_000)
    let content = original
    let revision = 1
    database.apply([put('incremental', original)])
    const inspect = new SyncDatabase(f.path, { readonly: true })
    try {
      for (let index = 0; index < EDITOR_RECOVERY_PATCH_LIMIT + 3; index++) {
        const next = index % 2 === 0 ? `${index}\udc00${content}` : `${content}\ud800`
        const patch = createEditorRecoveryTextPatch(content, next)
        if (!patch) {
          throw new Error('Expected an incremental edit')
        }
        const change: EditorRecoveryChange = {
          ...patch,
          kind: 'patch',
          id: 'incremental',
          expectedRevision: revision,
          metadata: metadata(),
          state: 'active'
        }
        expect(database.apply([change])).toEqual([{ id: 'incremental', revision: ++revision }])
        content = next
        expect(database.read('incremental')).toMatchObject({
          content,
          revision,
          byteLength: Buffer.byteLength(content)
        })
        const count = inspect
          .prepare('SELECT COUNT(*) AS count FROM editor_draft_patches')
          .get()?.count
        expect(Number(count)).toBeLessThan(EDITOR_RECOVERY_PATCH_LIMIT)
        if (index === EDITOR_RECOVERY_PATCH_LIMIT - 2) {
          expect(
            JSON.parse(
              String(inspect.prepare('SELECT content FROM editor_draft_bodies').get()?.content)
            )
          ).toBe(original)
        }
      }
      expect(inspect.prepare('SELECT content, patch_count FROM editor_drafts').get()).toMatchObject(
        { content: null, patch_count: 3 }
      )
    } finally {
      inspect.close()
    }
    database.apply([{ kind: 'retain', id: 'incremental', expectedRevision: revision++ }])
    database.close()
    databases.delete(database)
    const reopened = f.open()
    expect(reopened.read('incremental')).toMatchObject({ content, revision, state: 'retained' })
    expect(
      reopened.apply([{ kind: 'resolve', id: 'incremental', expectedRevision: revision }])[0]
        ?.revision
    ).toBe(revision + 1)
    const remaining = new SyncDatabase(f.path, { readonly: true })
    try {
      expect(
        remaining.prepare('SELECT COUNT(*) AS count FROM editor_draft_bodies').get()?.count
      ).toBe(0)
      expect(
        remaining.prepare('SELECT COUNT(*) AS count FROM editor_draft_patches').get()?.count
      ).toBe(0)
    } finally {
      remaining.close()
    }
  })

  it('rejects stale, mismatched and out-of-bounds patches and rolls back a failed patch batch', () => {
    const database = fixture().open()
    const original = 'a'.repeat(5_000)
    database.apply([put('one', original)])
    const patch = createEditorRecoveryTextPatch(original, `${original}edit`)
    if (!patch) {
      throw new Error('Expected an incremental edit')
    }
    const change: EditorRecoveryChange = {
      ...patch,
      kind: 'patch',
      id: 'one',
      expectedRevision: 1,
      metadata: metadata(),
      state: 'active'
    }
    for (const invalid of [
      { ...change, expectedRevision: 2 },
      { ...change, baseLength: 4_999 },
      { ...change, start: 5_001 },
      { ...change, metadata: metadata({ hostId: 'ssh:other' }) }
    ]) {
      expect(database.apply([invalid])).toEqual([{ id: 'one', revision: null }])
    }
    const originalExec = SyncDatabase.prototype.exec
    const fault = vi.spyOn(SyncDatabase.prototype, 'exec').mockImplementation(function (
      this: SyncDatabase,
      sql: string
    ) {
      if (sql === 'COMMIT') {
        throw new Error('checkpoint failed')
      }
      originalExec.call(this, sql)
    })
    expect(() => database.apply([change, put('two', 'second')])).toThrow('checkpoint failed')
    expect(database.read('one')).toMatchObject({ content: original, revision: 1 })
    expect(database.read('two')).toBeNull()
    fault.mockRestore()
    expect(database.apply([change])).toEqual([{ id: 'one', revision: 2 }])
    expect(database.read('one')?.content).toBe(`${original}edit`)
  })

  it('reads version-one bodies without eagerly copying them and migrates only an edited buffer', () => {
    const f = fixture()
    const original = '😀\ud800\0\r\n'.repeat(1_000)
    const previous = new SyncDatabase(f.path)
    previous.exec(`CREATE TABLE editor_drafts (
      id TEXT PRIMARY KEY, resource_key TEXT NOT NULL, metadata TEXT NOT NULL, content TEXT,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, state TEXT NOT NULL, byte_length INTEGER NOT NULL
    ) STRICT; PRAGMA user_version = 1;`)
    for (const id of ['edited', 'untouched']) {
      previous
        .prepare('INSERT INTO editor_drafts VALUES (?, ?, ?, ?, 7, 0, ?, ?)')
        .run(
          id,
          editorRecoveryResourceKey(metadata()),
          JSON.stringify(metadata()),
          JSON.stringify(original),
          'active',
          Buffer.byteLength(original)
        )
    }
    previous.close()
    const database = f.open()
    expect(database.read('edited')?.content).toBe(original)
    const patch = createEditorRecoveryTextPatch(original, `${original}new`)
    if (!patch) {
      throw new Error('Expected an incremental edit')
    }
    expect(
      database.apply([
        {
          ...patch,
          kind: 'patch',
          id: 'edited',
          expectedRevision: 7,
          metadata: metadata(),
          state: 'active'
        }
      ])
    ).toEqual([{ id: 'edited', revision: 8 }])
    expect(database.read('edited')?.content).toBe(`${original}new`)
    expect(database.read('untouched')?.content).toBe(original)
    const inspect = new SyncDatabase(f.path, { readonly: true })
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(2)
      expect(inspect.prepare('SELECT id FROM editor_draft_bodies').all()).toEqual([
        { id: 'edited' }
      ])
      expect(
        inspect.prepare('SELECT content FROM editor_drafts WHERE id = ?').get('untouched')?.content
      ).toBe(JSON.stringify(original))
    } finally {
      inspect.close()
    }
  })
})
