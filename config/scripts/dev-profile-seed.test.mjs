import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedDevProfile } from './dev-profile-seed.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function hashTree(dir) {
  const hash = createHash('sha256')
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const file = path.join(entry.parentPath, entry.name)
      hash.update(path.relative(dir, file)).update(readFileSync(file))
    }
  }
  return hash.digest('hex')
}

function createSourceProfile() {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-seed-source-'))
  roots.push(root)
  const profileDir = path.join(root, 'profiles', 'local-default')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    path.join(root, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: 1,
      activeProfileId: 'local-default',
      profiles: [{ id: 'local-default' }]
    })
  )
  writeFileSync(path.join(profileDir, 'account-session.json.enc'), '{"ciphertext":"x"}')
  writeFileSync(path.join(root, 'SingletonLock'), 'locked')
  mkdirSync(path.join(root, 'Code Cache'))
  writeFileSync(path.join(root, 'Code Cache', 'blob'), 'cache')
  const db = new DatabaseSync(path.join(profileDir, 'profile-state.db'))
  db.exec(
    'CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT NOT NULL, domain_version INTEGER, revision INTEGER, updated_at INTEGER, content_hash TEXT)'
  )
  const insert = db.prepare("INSERT INTO profile_state_documents VALUES (?, ?, 1, 1, 0, 'hash')")
  insert.run('repos', JSON.stringify([{ id: 'repo-1', path: '/src/app' }]))
  insert.run('settings', JSON.stringify({ theme: 'dark' }))
  insert.run('sshTargets', JSON.stringify([{ id: 'ssh-1' }]))
  insert.run('workspaceSession', JSON.stringify({ tabsByWorktree: { a: [] } }))
  insert.run('sshRemotePtyLeases', JSON.stringify([{ ptyId: 'p' }]))
  insert.run('automations', JSON.stringify([{ id: 'nightly' }]))
  db.close()
  return root
}

describe('seedDevProfile', () => {
  it('writes an importable slim profile and never changes the source', async () => {
    const source = createSourceProfile()
    const before = hashTree(source)
    const target = path.join(mkdtempSync(path.join(tmpdir(), 'orca-seed-target-')), 'profile')
    roots.push(path.dirname(target))

    await seedDevProfile({ sourceDir: source, targetDir: target, report: () => {} })

    expect(hashTree(source)).toBe(before)
    const seeded = JSON.parse(
      readFileSync(path.join(target, 'profiles', 'local-default', 'orca-data.json'), 'utf8')
    )
    expect(seeded).toEqual({
      repos: [{ id: 'repo-1', path: '/src/app' }],
      settings: { theme: 'dark' },
      sshTargets: [{ id: 'ssh-1' }]
    })
    expect(
      readFileSync(
        path.join(target, 'profiles', 'local-default', 'account-session.json.enc'),
        'utf8'
      )
    ).toBe('{"ciphertext":"x"}')
    expect(readdirSync(target).sort()).toEqual([
      'orca-dev-seed.json',
      'orca-profile-index.json',
      'profiles'
    ])
  })

  it('refuses to overwrite a profile that already has state', async () => {
    const source = createSourceProfile()
    const target = mkdtempSync(path.join(tmpdir(), 'orca-seed-target-'))
    roots.push(target)
    writeFileSync(path.join(target, 'orca-profile-index.json'), '{"existing":true}')

    await expect(
      seedDevProfile({ sourceDir: source, targetDir: target, report: () => {} })
    ).rejects.toThrow('already has state')
    expect(readFileSync(path.join(target, 'orca-profile-index.json'), 'utf8')).toBe(
      '{"existing":true}'
    )
  })
})
