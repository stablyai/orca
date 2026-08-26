/**
 * A folder workspace can pin its execution host while its repo stays local.
 * The desktop authority used to project only the repo, so those records listed
 * under Self while dispatch sent them to an SSH host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../../shared/automations-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import { AUTOMATION_ORPHAN_ISSUES } from '../../shared/automation-list-scope'
import { AutomationService } from './service'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const REPOS: Repo[] = [
  {
    id: 'repo-local',
    path: '/work/app/repo',
    displayName: 'Local',
    badgeColor: '#000',
    addedAt: 1,
    projectGroupId: 'group-1'
  }
] as Repo[]

const TARGETS: SshTarget[] = [
  { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me', generation: 7 }
] as SshTarget[]

function folderWorkspace(overrides: Partial<FolderWorkspace>): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'group-1',
    name: 'App',
    folderPath: '/work/app',
    ...overrides
  } as FolderWorkspace
}

const GROUPS: ProjectGroup[] = [
  { id: 'group-1', name: 'Work', parentPath: '/work' }
] as ProjectGroup[]

/** One local repo and one SSH repo in the same scope: no single host owns it. */
const AMBIGUOUS_REPOS: Repo[] = [
  ...REPOS,
  {
    id: 'repo-remote',
    path: '/work/app/remote',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 2,
    projectGroupId: 'group-1',
    connectionId: 'ssh-1'
  } as Repo
]

const AUTOMATION: Automation = {
  id: 'pinned-1',
  name: 'Nightly',
  prompt: 'go',
  precheck: null,
  agentId: 'claude',
  projectId: 'repo-local',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: 'folder:fw-1',
  baseBranch: null,
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY',
  dtstart: 0,
  enabled: true,
  nextRunAt: 0,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 0,
  updatedAt: 0
} as Automation

async function createStore(
  folderWorkspaces: FolderWorkspace[],
  repos: Repo[] = REPOS,
  extra: { automations?: Automation[]; projectHostSetups?: ProjectHostSetup[] } = {}
) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      repos,
      projectGroups: GROUPS,
      folderWorkspaces,
      sshTargets: TARGETS,
      sshTargetGenerationCounter: 7,
      projectHostSetups: extra.projectHostSetups ?? [],
      automations: extra.automations ?? [AUTOMATION]
    }),
    'utf-8'
  )
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-workspace-host-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('folder-workspace host attribution', () => {
  // The stored pin is `connectionId`; `executionHostId` is a renderer-side stamp that
  // normalization drops, so main can only ever see this form.
  it('files a pinned workspace under its SSH host instead of Self', async () => {
    const store = await createStore([folderWorkspace({ connectionId: 'ssh-1' })], [])

    expect(store.listAutomationsForScope({ selector: { kind: 'self' } }).automations).toEqual([])
    const scoped = store.listAutomationsForScope({
      selector: { kind: 'ssh', targetId: 'ssh-1', expectedTargetGeneration: 7 }
    })
    expect(scoped.automations.map((entry) => entry.id)).toEqual(['pinned-1'])
    expect(scoped.items[0]?.selector).toEqual({
      kind: 'ssh',
      targetId: 'ssh-1',
      targetGeneration: 7
    })
  })

  it('orphans a workspace whose scope spans two hosts rather than showing a healthy Self row', async () => {
    const store = await createStore([folderWorkspace({})], AMBIGUOUS_REPOS)

    expect(store.listAutomationsForScope({ selector: { kind: 'self' } }).automations).toEqual([])
    const orphans = store.listAutomationsForScope({ selector: { kind: 'orphan' } })
    expect(orphans.items[0]?.selector).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous
    })
  })

  it('leaves an unpinned local workspace on Self', async () => {
    const store = await createStore([folderWorkspace({})])

    expect(
      store.listAutomationsForScope({ selector: { kind: 'self' } }).automations.map((e) => e.id)
    ).toEqual(['pinned-1'])
  })
})

const AMBIGUOUS_REFUSAL =
  'The automation workspace spans more than one host, so Orca cannot tell which one to run it on.'

/**
 * Built through the store rather than seeded: load-time projection replaces any
 * repo-backed setup written by hand, so a literal run context would point at a
 * setup that no longer exists and be refused for that instead of the ambiguity.
 */
async function ambiguousStore() {
  vi.setSystemTime(new Date('2026-05-13T08:00:00'))
  const store = await createStore([folderWorkspace({})], AMBIGUOUS_REPOS, { automations: [] })
  const automation = store.createAutomation({
    name: 'Nightly',
    prompt: 'go',
    agentId: 'claude',
    projectId: 'repo-local',
    workspaceMode: 'existing',
    workspaceId: 'folder:fw-1',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00').getTime()
  })
  return { store, automation }
}

/** One scheduler pass. `nextRunAt` advancing is the signal that it finished. */
async function evaluated(
  seeded: Awaited<ReturnType<typeof ambiguousStore>>,
  start: () => void
): Promise<void> {
  vi.setSystemTime(new Date('2026-05-13T09:01:00'))
  start()
  await vi.waitFor(() =>
    expect(seeded.store.listAutomations()[0]?.nextRunAt).toBeGreaterThan(
      seeded.automation.nextRunAt
    )
  )
}

/**
 * The list calls this record an orphan, so the authority that owns it must refuse
 * to run it. Resolution would otherwise pick one of the two hosts on its own and
 * run the user's prompt somewhere they never chose — on a host they may not trust.
 */
describe('dispatch refused for an ambiguous workspace host', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'automation-ambiguous-dispatch-'))
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses the desktop dispatch and records why', async () => {
    const seeded = await ambiguousStore()
    const send = vi.fn()
    const service = new AutomationService(seeded.store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send } as never)

    await evaluated(seeded, () => service.setRendererReady())

    expect(send).not.toHaveBeenCalled()
    expect(seeded.store.listAutomationRuns(seeded.automation.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: AMBIGUOUS_REFUSAL
    })
    service.stop()
  })

  // Serve mode has no renderer to disable actions, so the authority is the only guard.
  it('refuses the headless dispatch, which has no ambiguity check of its own', async () => {
    const seeded = await ambiguousStore()
    const dispatcher = vi.fn(async () => ({ workspaceId: 'folder:fw-1', terminalSessionId: 't1' }))
    const service = new AutomationService(seeded.store, {
      tickMs: 60_000,
      headlessDispatcher: dispatcher
    })

    await evaluated(seeded, () => service.start())

    expect(dispatcher).not.toHaveBeenCalled()
    expect(seeded.store.listAutomationRuns(seeded.automation.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: AMBIGUOUS_REFUSAL
    })
    service.stop()
  })
})
