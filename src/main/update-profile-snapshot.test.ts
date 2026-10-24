import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import Database from './sqlite/sync-database'
import { createUpdateProfileSnapshot } from './update-profile-snapshot'
import { restoreUpdateProfileSnapshot } from './update-profile-restore'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-update-snapshot-'))
  roots.push(root)
  const profile = join(root, 'profile')
  await mkdir(profile)
  return { root, profile }
}
describe('Update backup and recovery', () => {
  it.runIf(process.platform !== 'win32')('restores POSIX filenames containing colons', async () => {
    const { root, profile } = await fixture()
    await writeFile(join(profile, 'a:b'), 'retained')
    const backup = await createUpdateProfileSnapshot(profile, 'v1')
    await restoreUpdateProfileSnapshot(backup, join(root, 'restored'))
    expect(await readFile(join(root, 'restored', 'a:b'), 'utf8')).toBe('retained')
  })
  it('excludes Chromium partition caches but retains same-named user folders', async () => {
    const { root, profile } = await fixture()
    for (const directory of ['Partitions/browser/Cache', 'documents/Cache']) {
      await mkdir(join(profile, directory), { recursive: true })
      await writeFile(join(profile, directory, 'entry'), 'retained')
    }
    const backup = await createUpdateProfileSnapshot(profile, 'v1')
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
    expect(manifest.entries.some((entry: { path: string }) => entry.path.includes('browser'))).toBe(
      true
    )
    expect(
      manifest.entries.some(
        (entry: { path: string }) => entry.path === join('Partitions', 'browser', 'Cache')
      )
    ).toBe(false)
    await restoreUpdateProfileSnapshot(backup, join(root, 'restored'))
    expect(await readFile(join(root, 'restored', 'documents', 'Cache', 'entry'), 'utf8')).toBe(
      'retained'
    )
  })
  it('retains two completed backups and leaves unrelated directories untouched', async () => {
    const { root, profile } = await fixture()
    const backupRoot = join(root, 'backups')
    await mkdir(join(backupRoot, 'user-files'), { recursive: true })
    await writeFile(join(backupRoot, 'user-files', 'keep'), 'keep')
    const backups: string[] = []
    for (let i = 0; i < 3; i++) {
      await writeFile(join(profile, 'settings.json'), String(i))
      backups.push(await createUpdateProfileSnapshot(profile, String(i), backupRoot))
    }
    await expect(readFile(join(backups[0], 'manifest.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    for (const index of [1, 2]) {
      await restoreUpdateProfileSnapshot(backups[index], join(root, `restore-${index}`))
      expect(await readFile(join(root, `restore-${index}`, 'settings.json'), 'utf8')).toBe(
        String(index)
      )
    }
    expect(await readFile(join(backupRoot, 'user-files', 'keep'), 'utf8')).toBe('keep')
  })
  it.runIf(process.platform !== 'win32')(
    'retains executable workflow files with private permissions',
    async () => {
      const { root, profile } = await fixture()
      const { chmod, stat } = await import('node:fs/promises')
      await writeFile(join(profile, 'workflow.sh'), '#!/bin/sh\nexit 0\n')
      await chmod(join(profile, 'workflow.sh'), 0o755)
      const backup = await createUpdateProfileSnapshot(profile, 'v1')
      const restored = join(root, 'restored-script')
      await restoreUpdateProfileSnapshot(backup, restored)
      expect((await stat(join(restored, 'workflow.sh'))).mode & 0o777).toBe(0o700)
    }
  )
  it('preserves WAL task records, settings, credentials, workflow documents and history through restore', async () => {
    const { root, profile } = await fixture()
    const documents = {
      'settings.json': '{"theme":"dark","custom":true}',
      'agent.key': 'isolated-test-key',
      'project-teams.json': '{"teams":[]}',
      'workflow.md': '# Existing workflow',
      'history.json': '["original"]'
    }
    for (const [name, bytes] of Object.entries(documents)) {
      await writeFile(join(profile, name), bytes)
    }
    const db = new Database(join(profile, 'orchestration.db'))
    let itemId: string
    let backup: string
    try {
      db.pragma('journal_mode = WAL')
      db.exec(
        "CREATE TABLE pending_tasks(id TEXT PRIMARY KEY, status TEXT, agent TEXT); INSERT INTO pending_tasks VALUES ('task-1', 'waiting', 'same-agent')"
      )
      itemId = 'task-1'
      backup = await createUpdateProfileSnapshot(profile, 'old-version')
      expect(db.prepare('SELECT status FROM pending_tasks WHERE id = ?').get(itemId)).toEqual({
        status: 'waiting'
      })
    } finally {
      db.close()
    }
    const restored = join(root, 'restored')
    await restoreUpdateProfileSnapshot(backup, restored)
    for (const [name, bytes] of Object.entries(documents)) {
      expect(await readFile(join(restored, name), 'utf8')).toBe(bytes)
      expect(await readFile(join(profile, name), 'utf8')).toBe(bytes)
    }
    const next = new Database(join(restored, 'orchestration.db'))
    try {
      expect(
        next.prepare('SELECT status, agent FROM pending_tasks WHERE id = ?').get(itemId)
      ).toEqual({ status: 'waiting', agent: 'same-agent' })
      next.prepare('UPDATE pending_tasks SET status = ? WHERE id = ?').run('completed', itemId)
      expect(next.prepare('SELECT status FROM pending_tasks WHERE id = ?').get(itemId)).toEqual({
        status: 'completed'
      })
    } finally {
      next.close()
    }
  })
  it('refuses corruption and an existing restore destination before writing user data', async () => {
    const { root, profile } = await fixture()
    await writeFile(join(profile, 'settings.json'), 'original')
    const backup = await createUpdateProfileSnapshot(profile, 'v1')
    await expect(restoreUpdateProfileSnapshot(backup, profile)).rejects.toThrow()
    await writeFile(join(backup, 'data', 'settings.json'), 'corrupted')
    await expect(restoreUpdateProfileSnapshot(backup, join(root, 'restore'))).rejects.toThrow(
      'checksum'
    )
    expect(await readFile(join(profile, 'settings.json'), 'utf8')).toBe('original')
  })
  it('captures an exclusively locked database without releasing or changing its owner', async () => {
    const { root, profile } = await fixture()
    const owner = new Database(join(profile, 'browser.db'))
    try {
      owner.exec(
        "PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('saved')"
      )
      const backup = await createUpdateProfileSnapshot(profile, 'v1')
      const restored = join(root, 'restored-locked')
      await restoreUpdateProfileSnapshot(backup, restored)
      const copy = new Database(join(restored, 'browser.db'))
      try {
        expect(copy.prepare('SELECT value FROM retained').get()).toEqual({ value: 'saved' })
        expect(owner.prepare('SELECT value FROM retained').get()).toEqual({ value: 'saved' })
      } finally {
        copy.close()
      }
    } finally {
      owner.close()
    }
  })
  it('retains empty profile directories through recovery', async () => {
    const { root, profile } = await fixture()
    await mkdir(join(profile, 'documents', 'empty'), { recursive: true })
    const backup = await createUpdateProfileSnapshot(profile, 'v1')
    const restored = join(root, 'recovered')
    await restoreUpdateProfileSnapshot(backup, restored)
    const { stat } = await import('node:fs/promises')
    expect((await stat(join(restored, 'documents', 'empty'))).isDirectory()).toBe(true)
  })
  it('rejects a backup inside the source profile', async () => {
    const { profile } = await fixture()
    await expect(
      createUpdateProfileSnapshot(profile, 'v1', join(profile, 'backups'))
    ).rejects.toThrow('outside')
  })
  it('backs up SQLite at a Windows long path without losing committed rows', async () => {
    const { root, profile } = await fixture()
    const db = new Database(join(profile, 'state.db'))
    try {
      db.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('original')")
    } finally {
      db.close()
    }
    const backup = await createUpdateProfileSnapshot(
      profile,
      'v1',
      join(root, 'long'.repeat(35), 'path'.repeat(30))
    )
    const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
    expect(manifest.entries).toHaveLength(1)
    expect(manifest.entries[0].path).toBe('state.db')
  })
  it.runIf(process.platform === 'win32')(
    'rejects case-aliased symlink ancestors before writing',
    async () => {
      const { root, profile } = await fixture()
      const backup = await createUpdateProfileSnapshot(profile, 'v1')
      const destination = join(root, 'rejected-case')
      await writeFile(
        join(backup, 'manifest.json'),
        JSON.stringify({
          format: 1,
          version: 'v1',
          createdAt: '',
          entries: [
            { path: 'Link', link: root },
            { path: 'link/child', link: 'external' }
          ]
        })
      )
      await expect(restoreUpdateProfileSnapshot(backup, destination)).rejects.toThrow('ancestor')
      const { lstat } = await import('node:fs/promises')
      await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(join(root, 'child'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
  it('rejects path traversal and symlink ancestors before creating a restored directory', async () => {
    const { root, profile } = await fixture()
    const backup = await createUpdateProfileSnapshot(profile, 'v1')
    for (const entries of [
      [{ path: '../outside', link: 'external' }],
      [
        { path: 'link', link: root },
        { path: 'link/child', link: 'external' }
      ]
    ]) {
      await writeFile(
        join(backup, 'manifest.json'),
        JSON.stringify({ format: 1, version: 'v1', createdAt: '', entries })
      )
      await expect(restoreUpdateProfileSnapshot(backup, join(root, 'rejected'))).rejects.toThrow()
    }
  })
})
