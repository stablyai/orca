import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  buildProfileStateCutoverFixture,
  canonicalProfileStateJson
} from './profile-state-cutover-fixture'
import {
  exportProfileStateJson,
  importProfileStateJson
} from './profile-state/profile-state-documents'
import {
  openProfileStateDatabase,
  profileStateDatabaseFile
} from './profile-state/profile-state-database'
import { Store } from './loading-store/store'
import {
  closeTestStores,
  createStore,
  dataFile,
  testState,
  writeDataFile
} from '../persistence-test-harness'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 2 }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

describe('profile-state cutover fixture', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-profile-cutover-fixture-'))
  })

  afterEach(async () => {
    await closeTestStores()
    removeTreeSync(testState.dir)
  })

  it('keeps object insertion order out of semantic comparisons while preserving array order', () => {
    expect(canonicalProfileStateJson({ b: 2, a: { d: 4, c: 3 }, rows: ['first', 'second'] })).toBe(
      canonicalProfileStateJson({ rows: ['first', 'second'], a: { c: 3, d: 4 }, b: 2 })
    )
    expect(canonicalProfileStateJson({ rows: ['first', 'second'] })).not.toBe(
      canonicalProfileStateJson({ rows: ['second', 'first'] })
    )
    expect(canonicalProfileStateJson({ missing: undefined, nullable: null })).toBe(
      canonicalProfileStateJson({ nullable: null })
    )
  })

  it('loads the cross-domain fixture through the legacy Store contract', () => {
    const fixture = buildProfileStateCutoverFixture(testState.dir)
    writeDataFile(fixture)

    const store = createStore()
    store.flushOrThrow()
    store.freezeWrites()

    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-local', 'repo-remote'])
    expect(store.getProjects().map((project) => project.id)).toEqual([
      'repo:repo-local',
      'repo:repo-remote'
    ])
    expect(store.getProjectHostSetups().map((setup) => setup.id)).toEqual([
      'repo-local',
      'repo-remote'
    ])
    expect(store.getWorktreeMeta('repo-local::/fixture/local')).toMatchObject({
      instanceId: 'instance-local',
      linkedPR: 42,
      comment: 'Preserve this comment'
    })
    expect(store.getWorkspaceSession().activeTabId).toBe('tab-local')
    expect(store.getWorkspaceSession('ssh:build-host').activeTabId).toBe('tab-remote')
    expect(store.listAutomations().map((automation) => automation.id)).toEqual([
      'automation-fixture'
    ])
    expect(store.listAutomationRuns('automation-fixture').map((run) => run.id)).toEqual([
      'automation-run-fixture'
    ])
    expect(store.getSettings().opencodeSessionCookie).toBe('fixture-secret')

    const persisted: unknown = JSON.parse(readFileSync(dataFile(), 'utf-8'))
    expect(persisted).toHaveProperty('futureTopLevelExtension', {
      keep: 'forward-compatible',
      nullable: null
    })
    expect(persisted).toHaveProperty(
      'settings.opencodeSessionCookie',
      fixture.settings.opencodeSessionCookie
    )

    const reloaded = createStore()
    reloaded.freezeWrites()
    expect(reloaded.getWorkspaceSession().activeTabId).toBe('tab-local')
    expect(reloaded.getWorkspaceSession('ssh:build-host').activeTabId).toBe('tab-remote')
    expect(reloaded.listAutomationRuns('automation-fixture')[0]?.outputSnapshot?.content).toBe(
      'fixture output'
    )
    expect(reloaded.getSettings().opencodeSessionCookie).toBe('fixture-secret')
  })

  it('imports and exports through the real Store normalization and secret boundaries', () => {
    const fixture = buildProfileStateCutoverFixture(testState.dir)
    writeDataFile(fixture)

    const source = createStore()
    source.flushOrThrow()
    const prepared = source.prepareProfileStateExport()
    const databaseDirectory = mkdtempSync(join(testState.dir, 'profile-state-db-'))
    const opened = openProfileStateDatabase(
      profileStateDatabaseFile(databaseDirectory),
      'profile-cutover'
    )
    try {
      importProfileStateJson(opened.db, prepared.json, { now: () => 456 })
      const exported = exportProfileStateJson(opened.db)
      prepared.commit()

      const candidateDirectory = mkdtempSync(join(testState.dir, 'candidate-'))
      const candidate = new Store({
        dataFile: join(candidateDirectory, 'orca-data.json'),
        serializedState: exported
      })

      expect(candidate.getSettings().opencodeSessionCookie).toBe('fixture-secret')
      expect(candidate.getWorkspaceSession().activeTabId).toBe('tab-local')
      expect(candidate.getWorkspaceSession('ssh:build-host').activeTabId).toBe('tab-remote')
      expect(candidate.listAutomationRuns('automation-fixture')[0]?.outputSnapshot?.content).toBe(
        'fixture output'
      )
      expect(candidate.getWorktreeMeta('repo-local::/fixture/local')).toMatchObject({
        linkedPR: 42,
        comment: 'Preserve this comment'
      })

      const persisted: unknown = JSON.parse(candidate.prepareProfileStateExport().json)
      expect(persisted).toHaveProperty('futureTopLevelExtension', fixture.futureTopLevelExtension)
      expect(persisted).toHaveProperty('settings.opencodeSessionCookie')
      expect(existsSync(join(candidateDirectory, 'orca-data.json'))).toBe(false)
    } finally {
      opened.db.close()
    }
  })

  it('fails closed for an invalid serialized import instead of reading a fallback file', () => {
    writeDataFile(buildProfileStateCutoverFixture(testState.dir))

    expect(() => new Store({ dataFile: dataFile(), serializedState: '{not valid json' })).toThrow(
      'Failed to load imported profile state'
    )
  })
})
