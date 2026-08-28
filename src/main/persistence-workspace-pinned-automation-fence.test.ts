/**
 * A `local`-typed automation whose folder workspace pins it to an SSH host is
 * projected as SSH-owned, so it must be fenceable like any other SSH-owned row.
 *
 * It used to capture no registration generation at all, so `captured ?? current`
 * always read the *current* one and `targetReplaced` could never fire: deleting
 * a host and re-adding one under the same id silently moved the schedule onto a
 * different machine. These tests drive the real Store through create and reload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation, AutomationCreateInput } from '../shared/automations-types'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import type { SshTarget } from '../shared/ssh-types'
import { AUTOMATION_ORPHAN_ISSUES } from '../shared/automation-list-scope'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../shared/automation-owner-conflict'
import { getDefaultPersistedState } from '../shared/constants'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const NOW = 1_700_000_000_000
const TARGET_ID = 'prod'
const FIRST_GENERATION = 4
const REPLACEMENT_GENERATION = 5

function prodTarget(generation: number): SshTarget {
  return {
    id: TARGET_ID,
    label: 'Prod box',
    host: 'prod.example.com',
    port: 22,
    username: 'tim',
    generation
  } as SshTarget
}

/** Local project outside the pinned folder scope: only the pin makes the record SSH-owned. */
function localRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/other/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1
  } as Repo
}

function projectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Group',
    // A folder-backed group: folder workspaces only survive normalization under one.
    parentPath: '/srv',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: NOW,
    updatedAt: NOW
  } as ProjectGroup
}

/** A remote-rooted folder workspace: its scope connection is the pin. */
function pinnedFolderWorkspace(): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'group-1',
    name: 'Pinned workspace',
    folderPath: '/srv/remote',
    connectionId: TARGET_ID,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW
  } as FolderWorkspace
}

function pinnedState(generation: number, overrides: Record<string, unknown> = {}) {
  return {
    repos: [localRepo()],
    projectGroups: [projectGroup()],
    folderWorkspaces: [pinnedFolderWorkspace()],
    sshTargets: [prodTarget(generation)],
    sshTargetGenerationCounter: generation,
    automations: [],
    ...overrides
  }
}

async function createStoreFromState(state: Record<string, unknown>) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), ...state }),
    'utf-8'
  )
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

async function reloadStore() {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

/** The same target id now carries a different registration incarnation. */
function replaceStoredTargetGeneration(generation: number): void {
  const file = join(testState.dir, 'orca-data.json')
  const state = JSON.parse(readFileSync(file, 'utf-8'))
  state.sshTargets = [prodTarget(generation)]
  state.sshTargetGenerationCounter = generation
  writeFileSync(file, JSON.stringify(state), 'utf-8')
}

const PINNED_CREATE_INPUT: AutomationCreateInput = {
  name: 'Nightly',
  prompt: 'go',
  agentId: 'codex',
  projectId: 'repo-1',
  workspaceMode: 'existing',
  workspaceId: folderWorkspaceKey('fw-1'),
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: NOW
}

function createPinnedAutomation(store: {
  createAutomation: (input: AutomationCreateInput) => Automation
}): Automation {
  return store.createAutomation(PINNED_CREATE_INPUT)
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-pinned-fence-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('workspace-pinned automations capture a registration generation', () => {
  it('stamps the pinned SSH target generation when the record is created', async () => {
    const store = await createStoreFromState(pinnedState(FIRST_GENERATION))

    const automation = createPinnedAutomation(store)

    expect(automation.executionTargetType).toBe('local')
    expect(automation.executionTargetGeneration).toBe(FIRST_GENERATION)
  })

  it('projects the pinned record onto the SSH host while the registration is unchanged', async () => {
    const store = await createStoreFromState(pinnedState(FIRST_GENERATION))
    createPinnedAutomation(store)

    expect(store.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'ssh',
      targetId: TARGET_ID,
      targetGeneration: FIRST_GENERATION
    })
  })

  it('orphans the pinned record when the same target id is re-added as a new incarnation', async () => {
    const store = await createStoreFromState(pinnedState(FIRST_GENERATION))
    createPinnedAutomation(store)
    store.flush()
    replaceStoredTargetGeneration(REPLACEMENT_GENERATION)

    const reloaded = await reloadStore()

    expect(reloaded.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced
    })
  })

  it('refuses to dispatch the pinned record onto the replacement machine', async () => {
    const store = await createStoreFromState(pinnedState(FIRST_GENERATION))
    createPinnedAutomation(store)
    store.flush()
    replaceStoredTargetGeneration(REPLACEMENT_GENERATION)

    const reloaded = await reloadStore()

    const automation = reloaded.listAutomations()[0]
    expect(reloaded.automationCapturedHostIssue(automation)).toBe(
      AUTOMATION_ORPHAN_ISSUES.targetReplaced
    )
    expect(() =>
      reloaded.assertAutomationOwnerFence({ id: automation.id, operation: 'execute' })
    ).toThrowError(expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved }))
  })

  it('backfills a legacy pinned record that was stored without a capture', async () => {
    const legacy = {
      id: 'auto-legacy',
      name: 'Legacy',
      prompt: 'go',
      precheck: null,
      agentId: 'codex',
      projectId: 'repo-1',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceMode: 'existing',
      workspaceId: folderWorkspaceKey('fw-1'),
      baseBranch: null,
      reuseSession: false,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: NOW,
      enabled: true,
      nextRunAt: NOW,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 720,
      createdAt: NOW,
      updatedAt: NOW
    }
    const store = await createStoreFromState(
      pinnedState(FIRST_GENERATION, { automations: [legacy] })
    )

    expect(store.listAutomations()[0].executionTargetGeneration).toBe(FIRST_GENERATION)
  })

  it('never re-stamps a differing capture, so a replacement cannot re-adopt the record', async () => {
    const store = await createStoreFromState(
      pinnedState(REPLACEMENT_GENERATION, {
        automations: [
          {
            id: 'auto-captured',
            name: 'Captured',
            prompt: 'go',
            precheck: null,
            agentId: 'codex',
            projectId: 'repo-1',
            executionTargetType: 'local',
            executionTargetId: 'local',
            executionTargetGeneration: FIRST_GENERATION,
            schedulerOwner: 'local_host_service',
            workspaceMode: 'existing',
            workspaceId: folderWorkspaceKey('fw-1'),
            baseBranch: null,
            reuseSession: false,
            timezone: 'UTC',
            rrule: 'FREQ=DAILY',
            dtstart: NOW,
            enabled: true,
            nextRunAt: NOW,
            missedRunPolicy: 'run_once_within_grace',
            missedRunGraceMinutes: 720,
            createdAt: NOW,
            updatedAt: NOW
          }
        ]
      })
    )

    expect(store.listAutomations()[0].executionTargetGeneration).toBe(FIRST_GENERATION)
    expect(store.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced
    })
  })
})

describe('the destination a pinned create lands on', () => {
  // The derived selection reads `local`; the record still lands on the pinned SSH host,
  // so accepting Self here scheduled a job on a machine the user did not choose.
  it('refuses a Self destination for a workspace-pinned record', async () => {
    const store = await createStoreFromState(pinnedState(FIRST_GENERATION))

    expect(() =>
      store.createAutomation(PINNED_CREATE_INPUT, { destination: { selector: { kind: 'self' } } })
    ).toThrowError(
      expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination })
    )
    expect(store.listAutomations()).toHaveLength(0)
  })

  it('accepts the pinned host as the destination', async () => {
    const store = await createStoreFromState(pinnedState(FIRST_GENERATION))

    const created = store.createAutomation(PINNED_CREATE_INPUT, {
      destination: {
        selector: { kind: 'ssh', targetId: TARGET_ID, targetGeneration: FIRST_GENERATION }
      }
    })

    expect(created.executionTargetGeneration).toBe(FIRST_GENERATION)
  })
})
