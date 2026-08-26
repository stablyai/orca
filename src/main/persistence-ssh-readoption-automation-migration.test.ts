/**
 * SSH re-adoption has to repair the automation with the workspace.
 *
 * `reassignSshTargetId` used to re-point only repos, worktrees, sessions and
 * setups, so a re-added host left every stored automation orphaned on the dead
 * target id and the persisted Automations host filter naming a host that no
 * longer existed. These tests drive the real Store through remove/re-add.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation, AutomationRun } from '../shared/automations-types'
import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import type { RemovedSshTargetTombstone } from '../shared/ssh-types'
import type { SshConnectionStore } from './ssh/ssh-connection-store'
import { getDefaultPersistedState } from '../shared/constants'
import { toSshExecutionHostId } from '../shared/execution-host'
import { hostStableKey } from '../shared/automation-owner-key'
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
const OLD_ID = 'ssh-1738000000000-a9f3x'
const IDENTITY = { host: 'dev.example.com', port: 22, username: 'tim' }

function desktopSshKey(targetId: string): string {
  return hostStableKey({ authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId } })
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-1',
    executionTargetType: 'ssh',
    executionTargetId: OLD_ID,
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
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
    updatedAt: NOW,
    ...overrides
  }
}

function makeRun(): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    runContext: {
      kind: 'workspace-run',
      projectId: 'project-1',
      hostId: toSshExecutionHostId(OLD_ID),
      projectHostSetupId: 'setup-1',
      repoId: 'repo-1',
      path: '/srv/repo'
    },
    title: 'Nightly #1',
    scheduledFor: NOW,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: NOW,
    dispatchedAt: NOW,
    createdAt: NOW
  }
}

function sshRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/srv/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1,
    connectionId: OLD_ID,
    executionHostId: `ssh:${OLD_ID}`
  } as Repo
}

function tombstone(overrides: Partial<RemovedSshTargetTombstone> = {}): RemovedSshTargetTombstone {
  return {
    oldTargetId: OLD_ID,
    ...IDENTITY,
    configHost: 'dev.example.com',
    label: 'Dev box',
    removedAt: NOW,
    ...overrides
  }
}

/** State as it looks right after the user removed the host: tombstone present, target gone. */
function removedHostState(overrides: Record<string, unknown> = {}) {
  return {
    repos: [sshRepo()],
    sshTargets: [],
    automations: [makeAutomation()],
    removedSshTargetTombstones: [tombstone()],
    ui: { ...getDefaultPersistedState(testState.dir).ui, automationHostFilter: undefined },
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

/** Re-read whatever is on disk now — no fixture rewrite. */
async function reloadStore() {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('./persistence')
  initDataPath()
  return new Store()
}

async function createSshStore(state: Record<string, unknown>) {
  const store = await createStoreFromState(state)
  const { SshConnectionStore } = await import('./ssh/ssh-connection-store')
  return { store, ssh: new SshConnectionStore(store) }
}

/** Re-add the same host the tombstone remembers. */
function readdDevBox(ssh: SshConnectionStore) {
  return ssh.addTarget({ label: 'Dev box', configHost: 'dev.example.com', ...IDENTITY })
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-readopt-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('SSH re-adoption migrates automations', () => {
  it('leaves the automation orphaned while the host is gone', async () => {
    const { store } = await createSshStore(removedHostState())
    const [item] = store.listAutomationsForScope().items
    expect(item.selector).toEqual({
      kind: 'orphan',
      issue: 'Its SSH host is no longer registered.'
    })
  })

  it('re-points the owner onto the re-added registration so it resolves again', async () => {
    const { store, ssh } = await createSshStore(removedHostState())

    const added = readdDevBox(ssh)

    const [item] = store.listAutomationsForScope().items
    expect(item.selector).toEqual({
      kind: 'ssh',
      targetId: added.id,
      targetGeneration: added.generation
    })
    expect(store.getRepo('repo-1')?.connectionId).toBe(added.id)
    // Enablement is the user's intent and is never rewritten by migration or re-adoption.
    expect(store.listAutomations()[0].enabled).toBe(true)
  })

  it('persists the automation, repo and filter migrations together', async () => {
    const { store, ssh } = await createSshStore(
      removedHostState({
        automationRuns: [makeRun()],
        ui: {
          ...getDefaultPersistedState(testState.dir).ui,
          automationHostFilter: { kind: 'host', hostKey: desktopSshKey(OLD_ID) }
        }
      })
    )

    const added = readdDevBox(ssh)
    store.flush()

    const reloaded = await reloadStore()
    const automation = reloaded.listAutomations()[0]
    expect(automation.executionTargetId).toBe(added.id)
    expect(automation.executionTargetGeneration).toBe(added.generation)
    expect(reloaded.getUI().automationHostFilter).toEqual({
      kind: 'host',
      hostKey: desktopSshKey(added.id)
    })
    expect(reloaded.listAutomationRuns('auto-1')[0].runContext?.hostId).toBe(`ssh:${added.id}`)
    expect(reloaded.getRepo('repo-1')?.connectionId).toBe(added.id)
  })

  it('repairs a folder workspace pinned to the removed host', async () => {
    const folderWorkspace: FolderWorkspace = {
      id: 'fw-1',
      projectGroupId: 'group-1',
      name: 'Remote folder',
      folderPath: '/srv/folder',
      connectionId: OLD_ID,
      executionHostId: toSshExecutionHostId(OLD_ID),
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW
    }
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Remote',
      parentPath: '/srv/folder',
      connectionId: OLD_ID,
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: NOW,
      updatedAt: NOW
    }
    // A folder workspace on SSH whose repo row is local: only the workspace pin names the host.
    const { store, ssh } = await createSshStore(
      removedHostState({
        repos: [{ ...sshRepo(), connectionId: undefined, executionHostId: 'local' } as Repo],
        folderWorkspaces: [folderWorkspace],
        projectGroups: [group],
        automations: [
          makeAutomation({
            executionTargetType: 'local',
            executionTargetId: 'local',
            workspaceMode: 'existing',
            workspaceId: folderWorkspaceKey('fw-1')
          })
        ]
      })
    )
    expect(store.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'orphan',
      issue: 'Its SSH host is no longer registered.'
    })

    const added = readdDevBox(ssh)

    expect(store.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'ssh',
      targetId: added.id,
      targetGeneration: added.generation
    })
  })

  it('keeps allocating generations above every migrated capture', async () => {
    const { store, ssh } = await createSshStore(
      removedHostState({
        automations: [makeAutomation({ executionTargetGeneration: 40 })],
        sshTargetGenerationCounter: 40
      })
    )

    const added = readdDevBox(ssh)

    expect(added.generation).toBeGreaterThan(40)
    expect(store.listAutomations()[0].executionTargetGeneration).toBe(added.generation)
    // The migrated capture must never be able to depress or collide with a later allocation.
    expect(store.allocateSshTargetGeneration()).toBeGreaterThan(added.generation!)
  })

  it('loads a pre-generation store and migrates it without dropping automations', async () => {
    // No generations, no persisted filter, no counter: state written by an older build.
    const { store, ssh } = await createSshStore({
      repos: [sshRepo()],
      sshTargets: [],
      automations: [makeAutomation()],
      removedSshTargetTombstones: [tombstone()],
      ui: {}
    })

    const added = readdDevBox(ssh)

    expect(store.listAutomations()).toHaveLength(1)
    expect(store.listAutomationsForScope().items[0].selector).toEqual({
      kind: 'ssh',
      targetId: added.id,
      targetGeneration: added.generation
    })
  })
})

describe('SSH re-adoption tombstone retention', () => {
  it('consumes the tombstone once nothing depends on its removal evidence', async () => {
    const { store, ssh } = await createSshStore(
      removedHostState({
        ui: {
          ...getDefaultPersistedState(testState.dir).ui,
          automationHostFilter: { kind: 'host', hostKey: desktopSshKey(OLD_ID) }
        }
      })
    )

    readdDevBox(ssh)

    expect(store.getRemovedSshTargetTombstones()).toEqual([])
  })

  it('retains the tombstone when a same-id re-registration leaves the automation on the old incarnation', async () => {
    const { store } = await createSshStore(removedHostState())
    const { readoptOrphanedWorkspacesForTarget } = await import('./ssh/ssh-target-readoption')
    // Same id back with a new registration: nothing is re-pointed, so the automation
    // still depends on the tombstone as the only evidence its host was replaced.
    const target = { id: OLD_ID, label: 'Dev box', ...IDENTITY, generation: 9 }
    store.addSshTarget(target)

    expect(readoptOrphanedWorkspacesForTarget(store, target)).toEqual([])
    expect(store.getRemovedSshTargetTombstones()).toHaveLength(1)
  })

  it('retains the tombstone while only the persisted filter still names the removed host', async () => {
    const { store } = await createSshStore(
      removedHostState({
        automations: [],
        ui: {
          ...getDefaultPersistedState(testState.dir).ui,
          automationHostFilter: { kind: 'host', hostKey: desktopSshKey(OLD_ID) }
        }
      })
    )

    store.releaseRemovedSshTargetTombstone(OLD_ID)

    expect(store.getRemovedSshTargetTombstones()).toHaveLength(1)
  })
})
