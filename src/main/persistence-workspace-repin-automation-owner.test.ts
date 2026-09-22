/**
 * A folder workspace can be re-pointed at another SSH host outside the automation
 * editor — the workspace's scope connection moves, and every record inside it
 * moves with it. The capture on those records names the registration they were
 * attached to, so it has to follow the pin or the record reads as a replaced
 * orphan on a host that was never replaced.
 *
 * Following is gated on positive evidence: a live registration carrying the
 * capture proves which pin it came from. Without that the capture stays put, so
 * a host removed and re-added under the same id still cannot re-adopt the record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import type { SshTarget } from '../shared/ssh-types'
import { AUTOMATION_ORPHAN_ISSUES } from '../shared/automation-list-scope'
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
const PROD_GENERATION = 4
const STAGING_GENERATION = 9

function target(id: string, generation: number): SshTarget {
  return {
    id,
    label: id,
    host: `${id}.example.com`,
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

function folderWorkspace(connectionId: string): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'group-1',
    name: 'Pinned workspace',
    folderPath: '/srv/remote',
    connectionId,
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

function pinnedAutomation() {
  return {
    id: 'auto-1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    executionTargetGeneration: PROD_GENERATION,
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
}

function initialState(): Record<string, unknown> {
  return {
    repos: [localRepo()],
    projectGroups: [projectGroup()],
    folderWorkspaces: [folderWorkspace('prod')],
    sshTargets: [target('prod', PROD_GENERATION), target('staging', STAGING_GENERATION)],
    sshTargetGenerationCounter: STAGING_GENERATION,
    automations: [pinnedAutomation()]
  }
}

async function loadStore(state: Record<string, unknown>) {
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

/** The workspace's execution host changes without any automation being edited. */
function repinWorkspace(connectionId: string, sshTargets?: SshTarget[]): void {
  const file = join(testState.dir, 'orca-data.json')
  const state = JSON.parse(readFileSync(file, 'utf-8'))
  state.folderWorkspaces = [folderWorkspace(connectionId)]
  if (sshTargets) {
    state.sshTargets = sshTargets
  }
  writeFileSync(file, JSON.stringify(state), 'utf-8')
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-workspace-repin-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('a workspace re-pinned outside the automation editor', () => {
  it('owns its records on the pin it started on', async () => {
    const store = await loadStore(initialState())

    expect(store.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'ssh',
      targetId: 'prod',
      targetGeneration: PROD_GENERATION
    })
  })

  it('moves the captured owner onto the registration it now names', async () => {
    const store = await loadStore(initialState())
    store.flush()
    repinWorkspace('staging')

    vi.resetModules()
    installFakeAppEnvironment({ getPath: () => testState.dir })
    const { Store, initDataPath } = await import('./persistence')
    initDataPath()
    const reloaded = new Store()

    expect(reloaded.listAutomations()[0].executionTargetGeneration).toBe(STAGING_GENERATION)
    expect(reloaded.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'ssh',
      targetId: 'staging',
      targetGeneration: STAGING_GENERATION
    })
    expect(reloaded.automationCapturedHostIssue(reloaded.listAutomations()[0])).toBeNull()
  })

  // No live registration carries the capture, so nothing proves it came from the old pin
  // rather than from this one before it was replaced. The record stays fenced.
  it('keeps the record fenced when the pin it left is gone too', async () => {
    const store = await loadStore(initialState())
    store.flush()
    repinWorkspace('staging', [target('staging', STAGING_GENERATION)])

    vi.resetModules()
    installFakeAppEnvironment({ getPath: () => testState.dir })
    const { Store, initDataPath } = await import('./persistence')
    initDataPath()
    const reloaded = new Store()

    expect(reloaded.listAutomations()[0].executionTargetGeneration).toBe(PROD_GENERATION)
    expect(reloaded.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced
    })
  })
})
