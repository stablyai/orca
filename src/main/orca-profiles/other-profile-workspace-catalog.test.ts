import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { getOrcaProfileStateDatabaseFile } from './profile-storage-paths'
import { getOtherProfileWorktreeIdsForHistoryGc } from './other-profile-workspace-catalog'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function userDataWithProfiles(
  activeProfileId: string,
  profiles: { id: string; state?: unknown; raw?: string }[]
): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-gc-profiles-'))
  roots.push(root)
  mkdirSync(join(root, 'profiles'), { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({
      activeProfileId,
      profiles: profiles.map(({ id }) => ({
        id,
        name: id,
        kind: 'local',
        createdAt: 0,
        updatedAt: 0,
        lastOpenedAt: 0,
        avatar: { kind: 'initials', initials: id.slice(0, 2), color: 'neutral' }
      }))
    })
  )
  for (const profile of profiles) {
    mkdirSync(join(root, 'profiles', profile.id), { recursive: true })
    if (profile.raw !== undefined) {
      writeFileSync(join(root, 'profiles', profile.id, 'orca-data.json'), profile.raw)
    } else if (profile.state !== undefined) {
      writeFileSync(
        join(root, 'profiles', profile.id, 'orca-data.json'),
        JSON.stringify(profile.state)
      )
    }
  }
  return root
}

describe('getOtherProfileWorktreeIdsForHistoryGc', () => {
  // The live Store owns active-profile IDs; rereading its file could race writes.

  it('prefers the profile database over a stale JSON export', () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: {} },
      {
        id: 'other',
        state: { worktreeMeta: { 'repo::/json': {} }, folderWorkspaces: [] }
      }
    ])
    const database = openProfileStateDatabase(
      getOrcaProfileStateDatabaseFile('other', root),
      'other'
    )
    try {
      importProfileStateJson(
        database.db,
        JSON.stringify({
          worktreeMeta: { 'repo::/database': {} },
          folderWorkspaces: [{ id: 'folder-database' }]
        })
      )
    } finally {
      database.db.close()
    }

    expect(getOtherProfileWorktreeIdsForHistoryGc(root)).toEqual({
      unreadableProfiles: 0,
      ids: new Set(['repo::/database', folderWorkspaceKey('folder-database')])
    })
  })

  it.each([true, false])(
    'refuses history pruning when SQLite is missing but a retained export exists (JSON: %s)',
    (hasJson) => {
      const state = { worktreeMeta: { 'repo::/stale-json': {} } }
      const root = userDataWithProfiles('active', [
        { id: 'active', state: {} },
        { id: 'other', ...(hasJson ? { state } : {}) }
      ])
      const dataFile = join(root, 'profiles', 'other', 'orca-data.json')
      const exportPath = `${dataFile}.sqlite-export.1.json`
      const exportJson = JSON.stringify({ worktreeMeta: { 'repo::/export': {} } })
      writeFileSync(exportPath, exportJson)

      expect(getOtherProfileWorktreeIdsForHistoryGc(root)).toEqual({
        unreadableProfiles: 1,
        ids: new Set()
      })
      expect(existsSync(getOrcaProfileStateDatabaseFile('other', root))).toBe(false)
      expect(existsSync(dataFile)).toBe(hasJson)
      if (hasJson) {
        expect(readFileSync(dataFile, 'utf8')).toBe(JSON.stringify(state))
      }
      expect(readFileSync(exportPath, 'utf8')).toBe(exportJson)
    }
  )

  it('does not fall back to JSON when an existing database is corrupt', () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: {} },
      { id: 'other', state: { worktreeMeta: { 'repo::/json': {} } } }
    ])
    writeFileSync(getOrcaProfileStateDatabaseFile('other', root), 'not a sqlite database')

    expect(getOtherProfileWorktreeIdsForHistoryGc(root)).toEqual({
      unreadableProfiles: 1,
      ids: new Set()
    })
  })

  it.each(['-wal', '-shm', '-journal'])(
    'does not fall back to JSON when only %s remains',
    (suffix) => {
      const root = userDataWithProfiles('active', [
        { id: 'active', state: {} },
        { id: 'other', state: { worktreeMeta: { 'repo::/json': {} } } }
      ])
      writeFileSync(
        `${getOrcaProfileStateDatabaseFile('other', root)}${suffix}`,
        'orphaned evidence'
      )

      expect(getOtherProfileWorktreeIdsForHistoryGc(root)).toEqual({
        unreadableProfiles: 1,
        ids: new Set()
      })
    }
  )

  it('refuses history pruning for a future profile database schema', () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: {} },
      { id: 'other', state: { worktreeMeta: { 'repo::/json': {} } } }
    ])
    const database = openProfileStateDatabase(
      getOrcaProfileStateDatabaseFile('other', root),
      'other'
    )
    database.db.pragma('user_version = 99')
    database.db.close()

    expect(getOtherProfileWorktreeIdsForHistoryGc(root)).toEqual({
      unreadableProfiles: 1,
      ids: new Set()
    })
  })

  // No index is a valid pre-profiles installation.
})
