import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type { PersistedState } from '../../shared/persisted-state-types'
import { getRepoMainWorktreeId } from '../../shared/worktree/id'
import { worktreeWorkspaceKey } from '../../shared/workspace-scope'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'
import * as database from '../persistence/profile-state/profile-state-database'
import { exportProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import { createProfileStateStore } from '../persistence/profile-state/profile-state-store-factory'
import { getOrcaProfileDataFile, getOrcaProfileStateDatabaseFile } from './profile-index-store'
import { initializeNewOrcaProfileState } from './new-profile-state'

const telemetry = {
  optedIn: false,
  installId: 'retained-install-id',
  existedBeforeTelemetryRelease: true
}
let root: string
const profileId = 'new-profile'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-profile-consent-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  removeTreeSync(root)
})

function readPublishedState(): PersistedState {
  const opened = database.openProfileStateDatabaseReadOnly(
    getOrcaProfileStateDatabaseFile(profileId, root),
    profileId
  )
  try {
    const state: PersistedState = JSON.parse(exportProfileStateJson(opened.db))
    return state
  } finally {
    opened.db.close()
  }
}

describe('new desktop profile initialization', () => {
  it.each([telemetry, undefined])(
    'publishes Home with fresh defaults and consent %j',
    (inherited) => {
      const runtime = acquireProfileStateRuntimeAdmission(root)
      try {
        initializeNewOrcaProfileState(profileId, inherited, root)
        const published = readPublishedState()
        const [home] = published.repos
        expect(published.repos).toHaveLength(1)
        expect(home).toMatchObject({ kind: 'folder', path: homedir(), displayName: 'Home' })
        expect(published.projects).toHaveLength(1)
        expect(published.projectHostSetups).toHaveLength(1)
        const worktreeId = getRepoMainWorktreeId(home)
        expect(published.workspaceSession).toMatchObject({
          activeRepoId: home.id,
          activeWorktreeId: worktreeId,
          activeWorkspaceKey: worktreeWorkspaceKey(worktreeId),
          activeWorkspaceExecutionHostId: 'local',
          activeTabId: null
        })
        expect(published.settings.telemetry).toEqual(
          inherited ??
            expect.objectContaining({
              existedBeforeTelemetryRelease: false,
              optedIn: true,
              installId: expect.any(String),
              onboardingLanguageCohort: expect.stringMatching(/^(control|treatment)$/)
            })
        )
        expect(published.settings.tabSwitchKeybindingSeed).toBe('done')
        expect(published.chatUiLaunchTipAudience).toEqual({
          version: 1,
          membership: 'excluded',
          basis: 'new-profile'
        })
        expect(published.ui).toMatchObject({
          projectOrderManualDefaultNoticeDismissed: true,
          usagePercentageDisplayChangeNoticeDismissed: true,
          statusBarCompactChangeNoticeDismissed: true
        })
        const options = {
          userDataPath: root,
          dataFile: getOrcaProfileDataFile(profileId, root),
          databaseFile: getOrcaProfileStateDatabaseFile(profileId, root),
          profileId,
          initializeHomeWorkspace: true
        }
        const first = createProfileStateStore(options).store
        expect(first.getRepos()).toEqual([expect.objectContaining(home)])
        expect(first.getSettings().telemetry).toEqual(published.settings.telemetry)
        expect(first.getWorkspaceSession().activeWorktreeId).toBe(worktreeId)
        first.flushOrThrow()
        first.freezeWrites()

        const reopened = createProfileStateStore(options).store
        expect(reopened.getRepos()).toEqual([expect.objectContaining(home)])
        expect(reopened.getSettings().telemetry).toEqual(published.settings.telemetry)
        reopened.removeProjectForHost({ id: home.id })
        reopened.flushOrThrow()
        reopened.freezeWrites()
        initializeNewOrcaProfileState(profileId, inherited, root)
        const afterRemoval = createProfileStateStore(options).store
        expect(afterRemoval.getRepos()).toEqual([])
        afterRemoval.freezeWrites()
        expect(existsSync(getOrcaProfileDataFile(profileId, root))).toBe(false)
        expect(() => runtime.assertActive()).not.toThrow()
      } finally {
        runtime.release()
      }
      const maintenance = acquireProfileStateMaintenance(root)
      maintenance.release()
    }
  )

  it('preserves established SQLite consent on a repeated seed', () => {
    initializeNewOrcaProfileState(profileId, telemetry, root)
    const original = readPublishedState()
    initializeNewOrcaProfileState(profileId, { ...telemetry, installId: 'replacement' }, root)
    expect(readPublishedState()).toEqual(original)
  })

  it('preserves existing JSON as input for its later import', () => {
    const path = getOrcaProfileDataFile(profileId, root)
    const original = '{"settings":{"telemetry":{"installId":"older"}}}'
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, original)

    initializeNewOrcaProfileState(profileId, telemetry, root)

    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, root))).toBe(false)
  })

  it('refuses seeding while maintenance owns the root', () => {
    const maintenance = acquireProfileStateMaintenance(root)
    try {
      expect(() => initializeNewOrcaProfileState(profileId, telemetry, root)).toThrow()
      expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, root))).toBe(false)
    } finally {
      maintenance.release()
    }
  })

  it.each(['orca-data.json.bak.0', 'orca-data.json.sqlite-export.1.json', 'profile-state.db-wal'])(
    'retains missing-authority evidence in %s',
    (name) => {
      const directory = dirname(getOrcaProfileDataFile(profileId, root))
      mkdirSync(directory, { recursive: true })
      const evidence = join(directory, name)
      writeFileSync(evidence, 'retained recovery evidence')

      expect(() => initializeNewOrcaProfileState(profileId, telemetry, root)).toThrow()

      expect(existsSync(getOrcaProfileDataFile(profileId, root))).toBe(false)
      expect(existsSync(getOrcaProfileStateDatabaseFile(profileId, root))).toBe(false)
      expect(readFileSync(evidence, 'utf8')).toBe('retained recovery evidence')
    }
  )
})
