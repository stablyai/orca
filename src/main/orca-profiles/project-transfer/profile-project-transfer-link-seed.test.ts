import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/orca-profiles/constants'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../../shared/orca-profiles/orca-profiles'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../../persistence/profile-state/documents/profile-state-documents'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../../persistence/profile-state/database/profile-state-database'
import { profileStateDatabaseFile } from '../../../shared/orca-profiles/profile-state-storage-paths'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

const testState = { dir: '' }
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

const TELEMETRY = { optedIn: true, installId: 'install-1', existedBeforeTelemetryRelease: false }
const REPO = {
  id: 'repo-1',
  path: '/workspace/orca',
  displayName: 'Orca',
  badgeColor: '#33aa99',
  addedAt: 100,
  kind: 'git',
  connectionId: null
}
const dbPath = (id: string): string => join(testState.dir, 'profiles', id, 'profile-state.db')
const dataPath = (id: string): string => join(testState.dir, 'profiles', id, 'orca-data.json')

function writeIndex(): void {
  writeFileSync(
    join(testState.dir, 'orca-profile-index.json'),
    JSON.stringify({
      schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
      activeProfileId: 'personal',
      profiles: ['personal', 'target'].map((id) => ({
        id,
        name: id,
        avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
        kind: 'local',
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1
      }))
    })
  )
}

function writeDb(id: string, root: unknown): void {
  mkdirSync(dirname(dbPath(id)), { recursive: true })
  const opened = openProfileStateDatabase(dbPath(id), id)
  try {
    if (root !== undefined) {
      importProfileStateJson(opened.db, JSON.stringify(root))
    }
  } finally {
    opened.db.close()
  }
}

function storedSettings(id: string): Record<string, unknown> {
  const opened = openProfileStateDatabaseReadOnly(dbPath(id), id)
  try {
    return JSON.parse(exportProfileStateJson(opened.db)).settings ?? {}
  } finally {
    opened.db.close()
  }
}

async function transferThenLoad(): Promise<Record<string, unknown>> {
  const { transferOrcaProfileProject } = await import('./profile-project-transfer')
  expect(
    transferOrcaProfileProject(
      { sourceProfileId: 'personal', targetProfileId: 'target', repoId: 'repo-1', mode: 'copy' },
      testState.dir
    ).status
  ).toBe('transferred')
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store } = await import('../../persistence/loading-store/store')
  const { ProfileStateSqliteAuthority } =
    await import('../../persistence/profile-state/profile-state-sqlite-authority')
  const authority = new (class extends ProfileStateSqliteAuthority {
    override scheduleBackup(): void {}
  })(profileStateDatabaseFile(dirname(dataPath('target'))), 'target')
  const store = new Store({ dataFile: dataPath('target'), profileStateAuthority: authority })
  store.flush()
  await store.freezeWritesAsync()
  return storedSettings('target')
}

describe('transfer into a profile that was never opened', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-transfer-link-seed-'))
    writeIndex()
    const defaults = getDefaultPersistedState('/Users/tester')
    writeDb('personal', { ...defaults, repos: [REPO] })
  })
  afterEach(() => rmSync(testState.dir, { recursive: true, force: true }))

  it('seeds a target with no state (initialization failed after the registry commit)', async () => {
    expect(existsSync(dbPath('target'))).toBe(false)
    expect(await transferThenLoad()).toMatchObject({
      httpLinkClickBehavior: 'open',
      openLinksInAppPreferencePrompted: true
    })
  })

  it('seeds a telemetry-only JSON target and keeps its telemetry', async () => {
    mkdirSync(dirname(dataPath('target')), { recursive: true })
    writeFileSync(dataPath('target'), JSON.stringify({ settings: { telemetry: TELEMETRY } }))
    const settings = await transferThenLoad()
    expect(settings.httpLinkClickBehavior).toBe('open')
    expect(settings.telemetry).toMatchObject(TELEMETRY)
  })

  it('treats an established SQLite target at revision 0 as absent', async () => {
    writeDb('target', undefined)
    expect((await transferThenLoad()).httpLinkClickBehavior).toBe('open')
  })

  it('seeds an established telemetry-only SQLite target', async () => {
    writeDb('target', { settings: { telemetry: TELEMETRY } })
    expect((await transferThenLoad()).httpLinkClickBehavior).toBe('open')
  })

  it('does not seed when another domain exists beside telemetry-only settings', async () => {
    writeDb('target', { settings: { telemetry: TELEMETRY }, projectGroups: [] })
    expect((await transferThenLoad()).httpLinkClickBehavior).toBe('ask')
  })

  it('does not seed a non-zero-revision empty root', async () => {
    writeDb('target', {})
    expect((await transferThenLoad()).httpLinkClickBehavior).toBe('ask')
  })

  it('keeps a defaults-saved Actions target asking with its saved browser', async () => {
    const defaults = getDefaultPersistedState('/Users/tester')
    writeDb('target', { ...defaults, settings: { ...defaults.settings, openLinksInApp: true } })
    expect(await transferThenLoad()).toMatchObject({
      httpLinkClickBehavior: 'ask',
      openLinksInApp: true
    })
  })
})
