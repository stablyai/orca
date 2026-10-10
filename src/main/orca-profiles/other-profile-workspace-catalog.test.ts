/**
 * Terminal history is keyed by worktree id under a root with no profile
 * segment, while the Store the GC consults holds one profile's ids. Without
 * these, switching profiles makes every other profile's history look orphaned.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { getOrcaProfileStateDatabaseFile } from './profile-storage-paths'
import {
  getOtherProfileWorktreeIdsForHistoryGc,
  readOtherProfileWorkspaceCatalog
} from './other-profile-workspace-catalog'

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
  it('collects worktrees and folder workspaces from the inactive profiles', () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: { worktreeMeta: { 'repo::/active': {} }, folderWorkspaces: [] } },
      {
        id: 'other',
        state: {
          worktreeMeta: { 'repo::/other': {}, 'repo::/other-2': {} },
          folderWorkspaces: [{ id: 'fw-other' }]
        }
      }
    ])

    const result = getOtherProfileWorktreeIdsForHistoryGc(root)

    expect(result.unreadableProfiles).toBe(0)
    expect(result.ids).toEqual(
      new Set(['repo::/other', 'repo::/other-2', folderWorkspaceKey('fw-other')])
    )
  })

  // The active profile's ids come from the live Store, which is authoritative;
  // re-reading its file would only race a write in progress.
  it('skips the active profile', () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: { worktreeMeta: { 'repo::/active': {} } } }
    ])

    expect(getOtherProfileWorktreeIdsForHistoryGc(root).ids.size).toBe(0)
  })

  it('reports a corrupt profile data file as unreadable rather than as no worktrees', () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: {} },
      { id: 'other', raw: '{ this is not json' }
    ])

    const result = getOtherProfileWorktreeIdsForHistoryGc(root)

    expect(result.unreadableProfiles).toBe(1)
    expect(result.ids.size).toBe(0)
  })

  it('reports a missing profile data file as unreadable', () => {
    const root = userDataWithProfiles('active', [{ id: 'active', state: {} }, { id: 'other' }])

    expect(getOtherProfileWorktreeIdsForHistoryGc(root).unreadableProfiles).toBe(1)
  })

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

  it('falls back to JSON without creating a database', () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: {} },
      { id: 'other', state: { worktreeMeta: { 'repo::/json': {} } } }
    ])
    const databaseFile = getOrcaProfileStateDatabaseFile('other', root)

    expect(getOtherProfileWorktreeIdsForHistoryGc(root)).toEqual({
      unreadableProfiles: 0,
      ids: new Set(['repo::/json'])
    })
    expect(existsSync(databaseFile)).toBe(false)
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

  it('reads SQLite-only profiles with retained exports without blocking history pruning', () => {
    const root = userDataWithProfiles('active', [{ id: 'active', state: {} }, { id: 'other' }])
    const database = openProfileStateDatabase(
      getOrcaProfileStateDatabaseFile('other', root),
      'other'
    )
    try {
      importProfileStateJson(
        database.db,
        JSON.stringify({ worktreeMeta: { 'repo::/database': {} } })
      )
    } finally {
      database.db.close()
    }
    const dataFile = join(root, 'profiles', 'other', 'orca-data.json')
    writeFileSync(
      `${dataFile}.sqlite-export.1.json`,
      JSON.stringify({ worktreeMeta: { 'repo::/stale-export': {} } })
    )

    expect(getOtherProfileWorktreeIdsForHistoryGc(root)).toEqual({
      unreadableProfiles: 0,
      ids: new Set(['repo::/database'])
    })
    expect(existsSync(dataFile)).toBe(false)
  })

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

  // A single-profile install must not pay for this, and no index at all is the
  // pre-profiles layout rather than an error.
  it('is empty and complete when there is no profile index', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-gc-profiles-'))
    roots.push(root)

    expect(getOtherProfileWorktreeIdsForHistoryGc(root)).toEqual({
      ids: new Set(),
      unreadableProfiles: 0
    })
  })
})

describe('readOtherProfileWorkspaceCatalog', () => {
  it("also names every other profile's projects", () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: { repos: [{ id: 'repo-active' }] } },
      { id: 'other', state: { repos: [{ id: 'repo-other' }, { id: '' }, null] } }
    ])
    const catalog = readOtherProfileWorkspaceCatalog(root)
    expect(catalog.repoIds).toEqual(new Set(['repo-other']))
    expect(catalog.unreadableProfiles).toBe(0)
  })

  it('counts a profile whose projects are not a list as unreadable', () => {
    const root = userDataWithProfiles('active', [
      { id: 'active', state: {} },
      { id: 'other', state: { repos: { 'repo-other': {} } } }
    ])
    expect(readOtherProfileWorkspaceCatalog(root).unreadableProfiles).toBe(1)
  })

  it('skips the running profile even when the index already names another as active', () => {
    const root = userDataWithProfiles('next', [
      { id: 'running', state: { repos: [{ id: 'repo-running' }] } },
      { id: 'next', state: { repos: [{ id: 'repo-next' }] } }
    ])
    const catalog = readOtherProfileWorkspaceCatalog(root, { runningProfileId: 'running' })
    expect(catalog.repoIds).toEqual(new Set(['repo-next']))
  })

  it('counts a never-written profile as empty only when asked', () => {
    const root = userDataWithProfiles('active', [{ id: 'active', state: {} }, { id: 'fresh' }])
    expect(readOtherProfileWorkspaceCatalog(root).unreadableProfiles).toBe(1)
    const lenient = readOtherProfileWorkspaceCatalog(root, { neverWrittenIsEmpty: true })
    expect(lenient.unreadableProfiles).toBe(0)
    expect(lenient.repoIds.size).toBe(0)
  })

  it('never counts a profile with only backups of its data file as empty', () => {
    const root = userDataWithProfiles('active', [{ id: 'active', state: {} }, { id: 'lost' }])
    writeFileSync(join(root, 'profiles', 'lost', 'orca-data.json.bak.0'), '{}')
    expect(
      readOtherProfileWorkspaceCatalog(root, { neverWrittenIsEmpty: true }).unreadableProfiles
    ).toBe(1)
  })
})
