import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ORCA_PROFILE_INDEX_SCHEMA_VERSION } from '../../../shared/orca-profiles/orca-profiles'
import type { OrcaProfileSummary } from '../../../shared/orca-profiles/orca-profiles'
import {
  closeTestStores,
  createSqliteTestStore,
  makeRepo,
  readPersistedState,
  testState
} from '../../persistence/persistence-test-harness'
import { Store } from '../../persistence/loading-store/store'
import { initDataPath } from '../../persistence/loading-store/user-data-path'
import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { getOrcaProfileDataFile, getOrcaProfileIndexPath } from '../profile-storage-paths'
import { writeProfileIndex } from '../profile-index-store'
import { transferOrcaProfileProject } from './profile-project-transfer'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

// The test Store opens profile state as 'persistence-test', so the target uses that id.
const SOURCE = 'source'
const TARGET = 'persistence-test'
const REPO = makeRepo({ id: 'repo-1', path: '/tmp/orca-transfer-repo' })

function profile(id: string): OrcaProfileSummary {
  return {
    id,
    name: id,
    avatar: { kind: 'initials', initials: 'T', color: 'neutral' },
    kind: 'local',
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1
  }
}

function writeProfileJson(profileId: string, root: unknown): void {
  const path = getOrcaProfileDataFile(profileId, testState.dir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(root))
}

const existingTarget = (settings: Record<string, unknown>) => ({
  schemaVersion: 1,
  repos: [],
  worktreeMeta: {},
  settings: { theme: 'dark', floatingTerminalDefaultedForAllUsers: true, ...settings },
  ui: { sidebarWidth: 280 },
  githubCache: { pr: {}, issue: {} },
  workspaceSession: {}
})

async function transferThenLoad(targetRoot: unknown) {
  writeProfileIndex(getOrcaProfileIndexPath(testState.dir), {
    schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId: SOURCE,
    profiles: [profile(SOURCE), profile(TARGET)]
  })
  writeProfileJson(SOURCE, { schemaVersion: 1, repos: [REPO], settings: {}, ui: {} })
  writeProfileJson(TARGET, targetRoot)
  const result = transferOrcaProfileProject(
    { sourceProfileId: SOURCE, targetProfileId: TARGET, repoId: REPO.id, mode: 'copy' },
    testState.dir
  )
  expect(result.status).not.toBe('duplicate-target')
  const dataFile = getOrcaProfileDataFile(TARGET, testState.dir)
  const persisted = readPersistedState(dataFile, TARGET).settings
  installFakeAppEnvironment({ getPath: () => testState.dir })
  initDataPath()
  const loaded = createSqliteTestStore(Store, { dataFile }).getSettings()
  await closeTestStores()
  return { persisted, loaded }
}

describe('project transfer into a profile keeps its floating workspace choice', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-floating-transfer-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('leaves a stamped profile without a saved value to the loader instead of writing false', async () => {
    const { persisted, loaded } = await transferThenLoad(existingTarget({}))
    expect(Object.hasOwn(persisted, 'floatingTerminalEnabled')).toBe(false)
    expect([loaded.floatingWorkspaceInSettings, loaded.floatingTerminalEnabled]).toEqual([
      true,
      true
    ])
  })

  it('keeps an explicit on and an explicit off', async () => {
    const on = await transferThenLoad(existingTarget({ floatingTerminalEnabled: true }))
    expect([on.loaded.floatingWorkspaceInSettings, on.loaded.floatingTerminalEnabled]).toEqual([
      true,
      true
    ])
    rmSync(testState.dir, { recursive: true, force: true })
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-floating-transfer-'))
    const off = await transferThenLoad(existingTarget({ floatingTerminalEnabled: false }))
    expect([off.loaded.floatingWorkspaceInSettings, off.loaded.floatingTerminalEnabled]).toEqual([
      true,
      false
    ])
  })

  it('treats a never-loaded telemetry-only target as new', async () => {
    const { loaded } = await transferThenLoad({
      settings: {
        telemetry: { optedIn: true, existedBeforeTelemetryRelease: true, installId: 'install-1' }
      }
    })
    expect([loaded.floatingWorkspaceInSettings, loaded.floatingTerminalEnabled]).toEqual([
      false,
      false
    ])
  })
})
