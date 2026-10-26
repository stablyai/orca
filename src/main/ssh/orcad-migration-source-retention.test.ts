import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Repo } from '../../shared/repo-types'
import type { PersistedOpenFile } from '../../shared/workspace-session-state-types'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import { listPendingManagedOrcadMigrations } from '../managed-server/lifecycle/orcad-managed-migration-status'
import {
  retainUnretainedOrcadMigrationSources,
  retainOrcadMigrationSource
} from './orcad-migration-source-retention'

const TARGET_ID = 'ssh-1'
const SOURCE_HOST = `ssh:${TARGET_ID}`
const SERVER_HOST = 'runtime:env-1'
const WORKTREE = 'repo-1::/srv/app'
const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '#737373',
  addedAt: 1,
  kind: 'git',
  connectionId: TARGET_ID
}

let userDataPath: string
let store: Store

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-retention-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

function committed(migrationId = 'm-1') {
  const cutover = orcadMigrationCutoverFixture(migrationId, TARGET_ID)
  return {
    ...cutover,
    phase: 'destination-committed' as const,
    manifest: {
      ...cutover.manifest,
      payload: { ...cutover.manifest.payload, repositories: [REPO] }
    }
  }
}

function draftedFile(filePath: string, draft: string): PersistedOpenFile {
  return {
    filePath,
    relativePath: filePath.slice('/srv/app/'.length),
    worktreeId: WORKTREE,
    language: 'markdown',
    dirtyDraftContent: draft,
    lastKnownDiskSignature: 'base-1'
  }
}

function saveFiles(hostId: string, files: PersistedOpenFile[]): void {
  store.setWorkspaceSession(
    { ...store.getWorkspaceSession(hostId), openFilesByWorktree: { [WORKTREE]: files } },
    hostId
  )
}

async function restart(): Promise<void> {
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
}

const serverFiles = () => store.getWorkspaceSession(SERVER_HOST).openFilesByWorktree?.[WORKTREE]

describe('retaining a committed migration source', () => {
  it('marks only a committed cutover, idempotently, and stops counting it as pending', async () => {
    writeOrcadMigrationSourceCutover(userDataPath, orcadMigrationCutoverFixture('m-1'))
    await expect(retainOrcadMigrationSource(userDataPath, 'm-1', store)).rejects.toThrow(
      'orcad_migration_retain_before_commit'
    )
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('m-1'),
      phase: 'destination-committed'
    })
    const at = () => new Date('2026-10-03T00:00:00.000Z')
    await retainOrcadMigrationSource(userDataPath, 'm-1', store, at)
    await retainOrcadMigrationSource(
      userDataPath,
      'm-1',
      store,
      () => new Date('2026-12-01T00:00:00.000Z')
    )
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBe(
      '2026-10-03T00:00:00.000Z'
    )
    expect(listPendingManagedOrcadMigrations(userDataPath)).toEqual([])
  })

  it('does not count retained cutovers against the in-flight journal capacity', () => {
    for (let index = 0; index < 4; index += 1) {
      const id = `m-${index}`
      writeOrcadMigrationSourceCutover(userDataPath, {
        ...orcadMigrationCutoverFixture(id, `ssh-${index}`),
        phase: 'destination-committed',
        sourceRetainedAt: '2026-10-03T00:00:00.000Z'
      })
    }
    expect(() =>
      writeOrcadMigrationSourceCutover(userDataPath, orcadMigrationCutoverFixture('m-new', 'ssh-9'))
    ).not.toThrow()
  })
})

describe('renaming unsaved drafts to the server on commit', () => {
  beforeEach(() => {
    store.addSshTarget({
      id: TARGET_ID,
      label: 'Prod',
      host: 'h',
      port: 22,
      username: 'u',
      generation: 2
    })
    store.addRepo(REPO)
  })

  it('moves the host and desktop drafts, with their baseline, and leaves the source as it was', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/host.md', 'host draft')])
    saveFiles('local', [draftedFile('/srv/app/desktop.md', 'desktop draft')])
    const source = JSON.stringify(store.getWorkspaceSession(SOURCE_HOST))
    writeOrcadMigrationSourceCutover(userDataPath, committed())

    await retainOrcadMigrationSource(userDataPath, 'm-1', store)

    expect(serverFiles()).toEqual([
      { ...draftedFile('/srv/app/host.md', 'host draft'), runtimeEnvironmentId: 'env-1' },
      { ...draftedFile('/srv/app/desktop.md', 'desktop draft'), runtimeEnvironmentId: 'env-1' }
    ])
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeDefined()
    expect(JSON.stringify(store.getWorkspaceSession(SOURCE_HOST))).toBe(source)
    await store.flushPendingOrThrowAsync()
    await closeTestStores()
    store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
    expect(serverFiles()?.map((file) => file.dirtyDraftContent)).toEqual([
      'host draft',
      'desktop draft'
    ])
  })

  it('keeps what the server partition already holds, and never revives a discarded draft', async () => {
    saveFiles(SOURCE_HOST, [
      draftedFile('/srv/app/a.md', 'source A'),
      draftedFile('/srv/app/b.md', 'source B')
    ])
    saveFiles(SERVER_HOST, [{ ...draftedFile('/srv/app/a.md', 'newer A') }])
    writeOrcadMigrationSourceCutover(userDataPath, committed())

    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(serverFiles()?.map((file) => file.dirtyDraftContent)).toEqual(['newer A', 'source B'])

    saveFiles(SERVER_HOST, [])
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(serverFiles()).toEqual([])
    await restart()
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(serverFiles()).toEqual([])
  })

  it('renames and retains at startup after a cut-off commit, so a draft closed later stays closed', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/a.md', 'source A')])
    writeOrcadMigrationSourceCutover(userDataPath, committed())
    await restart()

    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(serverFiles()?.map((file) => file.dirtyDraftContent)).toEqual(['source A'])
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeDefined()
    // Later retain/start must not resurrect a draft closed before connect.
    saveFiles(SERVER_HOST, [])
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    await restart()
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(serverFiles()).toEqual([])
  })

  it('shares one retain between concurrent callers, so a later one never renames again', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/a.md', 'source A')])
    writeOrcadMigrationSourceCutover(userDataPath, committed())
    const first = retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(retainOrcadMigrationSource(userDataPath, 'm-1', store)).toBe(first)
    await first
    saveFiles(SERVER_HOST, [])
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(serverFiles()).toEqual([])
  })

  it("never retains another profile's migration at startup", async () => {
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('m-9', 'ssh-other-profile'),
      phase: 'destination-committed'
    })
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeUndefined()
  })

  it('keeps newer typing in the server copy when the connect retains first', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/a.md', 'source A')])
    saveFiles(SERVER_HOST, [
      { ...draftedFile('/srv/app/a.md', 'typed after'), runtimeEnvironmentId: 'env-1' }
    ])
    writeOrcadMigrationSourceCutover(userDataPath, committed())
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(serverFiles()?.map((file) => file.dirtyDraftContent)).toEqual(['typed after'])
  })

  it('makes the startup rename durable before its retained mark', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/a.md', 'source A')])
    writeOrcadMigrationSourceCutover(userDataPath, committed())
    await restart()
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeDefined()
    // Reopen from disk to model a crash before pending writes land.
    const crashed = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
    expect(
      crashed.getWorkspaceSession(SERVER_HOST).openFilesByWorktree?.[WORKTREE]?.[0]
        ?.dirtyDraftContent
    ).toBe('source A')
  })

  it("leaves another host's file and another project's draft where they are", async () => {
    saveFiles(SOURCE_HOST, [
      { ...draftedFile('/srv/app/remote.md', 'other host'), runtimeEnvironmentId: 'env-9' }
    ])
    store.setWorkspaceSession(
      {
        ...store.getWorkspaceSession(SOURCE_HOST),
        openFilesByWorktree: {
          ...store.getWorkspaceSession(SOURCE_HOST).openFilesByWorktree,
          'repo-2::/srv/other': [draftedFile('/srv/other/x.md', 'other project')]
        }
      },
      SOURCE_HOST
    )
    writeOrcadMigrationSourceCutover(userDataPath, committed())

    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(store.getWorkspaceSession(SERVER_HOST).openFilesByWorktree ?? {}).toEqual({})
  })
})
