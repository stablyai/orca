import type { PersistedState } from '../../shared/persisted-state-types'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
// Moving a definition must publish both hosts or source subscribers retain a stale row.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../shared/automation-owner-conflict'
import type { AutomationOwnerPrecondition } from '../../shared/automation-owner-precondition'
import { AutomationService } from '../automations/service'
import { Store, initDataPath } from '../persistence'
import { OrcaRuntimeService } from './orca-runtime'
import * as worktreeChangeInvalidators from '../ipc/worktree-change-invalidators'
import { _resetTerminalModelQueryAuthorityForTest } from './terminal-model-query-authority'
import { _resetTerminalViewAttributesForTest } from './terminal-view-attribute-store'

const testState = { dir: '' }
let registrationSpy:
  | MockInstance<typeof worktreeChangeInvalidators.registerWorktreeChangeInvalidator>
  | undefined

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const REPOS = [
  { id: 'repo-local', path: '/local', displayName: 'Local', badgeColor: '#000', addedAt: 1 },
  {
    id: 'repo-ssh',
    path: '/remote',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 2,
    connectionId: 'ssh-1'
  }
] as Repo[]

const TARGETS = [
  { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me', generation: 7 }
] as SshTarget[]

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'local-1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-local',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
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
    updatedAt: 0,
    ...overrides
  } as Automation
}

const AUTOMATIONS = [
  automation({}),
  automation({
    id: 'ssh-1-a',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-1',
    executionTargetGeneration: 7
  }),
  automation({
    id: 'orphan-1',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-gone',
    executionTargetGeneration: 3
  })
]

async function makeRuntime(overrides: Partial<PersistedState> = {}) {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      repos: REPOS,
      sshTargets: TARGETS,
      sshTargetGenerationCounter: 7,
      automations: AUTOMATIONS,
      ...overrides
    }),
    'utf-8'
  )
  initDataPath()
  const store = createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
  const runtime = new OrcaRuntimeService(store as never)
  const published: AutomationsChangedPayload[] = []
  vi.spyOn(runtime, 'notifyAutomationsChanged').mockImplementation(
    (payload: AutomationsChangedPayload = {}) => {
      published.push(payload)
    }
  )
  return { store, runtime, published }
}

async function makeManualRunRuntime() {
  const { store, runtime } = await makeRuntime()
  runtime.setAutomationService(new AutomationService(store, { tickMs: 60_000 }))
  return { store, runtime }
}

type RuntimeWithRunNow = {
  runAutomationNow: (
    id: string,
    expectedOwner?: AutomationOwnerPrecondition
  ) => Promise<AutomationRun>
}

const runNow = async (
  runtime: RuntimeWithRunNow,
  id: string,
  expectedOwner?: AutomationOwnerPrecondition
): Promise<AutomationRun> => await runtime.runAutomationNow(id, expectedOwner)

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-publish-'))
  // Store resolves its data path through the app environment; point it at the fixture.
  installFakeAppEnvironment({
    getPath: (name) => (name === 'userData' ? testState.dir : tmpdir())
  })
  registrationSpy = vi.spyOn(worktreeChangeInvalidators, 'registerWorktreeChangeInvalidator')
})

afterEach(async () => {
  try {
    await closeTestStores()
  } finally {
    try {
      // Runtime callbacks must end with their fixture.
      for (const result of registrationSpy?.mock.results ?? []) {
        if (result.type === 'return') {
          result.value()
        }
      }
    } finally {
      registrationSpy?.mockRestore()
      registrationSpy = undefined
      _resetTerminalModelQueryAuthorityForTest()
      _resetTerminalViewAttributesForTest()
      rmSync(testState.dir, { recursive: true, force: true })
    }
  }
})

describe('scoped automationsChanged publication', () => {
  it.each(['update', 'delete'] as const)(
    'waits for durable %s before publishing success',
    async (operation) => {
      const { store, runtime, published } = await makeRuntime()
      const gate = Promise.withResolvers<void>()
      vi.spyOn(store, 'flushPendingOrThrowAsync').mockReturnValue(gate.promise)
      const pending =
        operation === 'update'
          ? runtime.updateAutomation('local-1', { name: 'Changed' })
          : runtime.deleteAutomation('local-1')
      await vi.waitFor(() => expect(store.flushPendingOrThrowAsync).toHaveBeenCalledOnce())
      expect(published).toEqual([])
      gate.resolve()
      await pending
      expect(published).toHaveLength(1)
    }
  )

  it('rejects a failed durable definition write without publishing success', async () => {
    const { store, runtime, published } = await makeRuntime()
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValue(new Error('disk full'))
    await expect(runtime.updateAutomation('local-1', { name: 'Changed' })).rejects.toThrow(
      'disk full'
    )
    expect(published).toEqual([])
  })

  it('names the host a delete removed a row from', async () => {
    const { runtime, published } = await makeRuntime()
    await runtime.deleteAutomation('ssh-1-a', {
      selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 }
    })
    expect(published).toEqual([
      { reason: 'definition', selector: { kind: 'ssh', targetId: 'ssh-1' } }
    ])
  })

  it('names the orphan bucket when an unowned row is deleted', async () => {
    const { runtime, published } = await makeRuntime()
    await runtime.deleteAutomation('orphan-1', { selector: { kind: 'orphan' } })
    expect(published).toEqual([{ reason: 'definition', selector: { kind: 'orphan' } }])
  })

  it('publishes source and destination when an update moves a record between hosts', async () => {
    const { runtime, published, store } = await makeRuntime()
    await runtime.updateAutomation(
      'local-1',
      { repo: 'repo-ssh' },
      {
        expectedOwner: { selector: { kind: 'self' } },
        destination: { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 7 } }
      }
    )
    expect(published).toEqual([
      { reason: 'definition', selector: { kind: 'self' } },
      { reason: 'definition', selector: { kind: 'ssh', targetId: 'ssh-1' } }
    ])
    expect(store.automationChangeSelector('local-1')).toEqual({
      kind: 'ssh',
      targetId: 'ssh-1'
    })
  })

  it('publishes one event when an update leaves the record on the same host', async () => {
    const { runtime, published } = await makeRuntime()
    await runtime.updateAutomation(
      'local-1',
      { enabled: false },
      { expectedOwner: { selector: { kind: 'self' } } }
    )
    expect(published).toEqual([{ reason: 'definition', selector: { kind: 'self' } }])
  })

  // Unknown destinations require an unscoped event so every affected subscriber hears the change.
  it('degrades to an unscoped event when the store cannot name the destination', async () => {
    const { store, runtime, published } = await makeRuntime()
    const selector = store.automationChangeSelector.bind(store)
    let updated = false
    vi.spyOn(store, 'automationChangeSelector').mockImplementation((id: string) =>
      updated ? null : selector(id)
    )
    const update = runtime.updateAutomation(
      'local-1',
      { enabled: false },
      { expectedOwner: { selector: { kind: 'self' } } }
    )
    updated = true
    await update

    expect(published).toEqual([{ reason: 'definition' }])
  })
})

describe('manual run refused before dispatch', () => {
  it('records a truthful reselection refusal for a bare legacy run without execution, and fences stale callers first', async () => {
    const record = automation({
      id: 'repair',
      projectId: 'repo-ssh',
      precheck: { command: 'must not run', timeoutSeconds: 30 },
      runContext: {
        kind: 'workspace-run',
        repoId: 'repo-ssh',
        projectId: 'logical-project',
        projectHostSetupId: 'saved-setup',
        hostId: 'ssh:ssh-1',
        path: '/remote'
      }
    })
    const { store, runtime } = await makeRuntime({
      repos: [{ ...REPOS[1], connectionId: undefined, executionHostId: 'ssh:ssh-1' }],
      automations: [record],
      projectHostSetups: [
        {
          id: 'saved-setup',
          projectId: 'logical-project',
          repoId: 'repo-ssh',
          hostId: 'ssh:ssh-1',
          path: '/remote',
          displayName: 'App',
          setupState: 'ready',
          setupMethod: 'legacy-repo',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const dispatch = vi.fn(async () => {
      throw new Error('Unexpected execution')
    })
    const service = new AutomationService(store, { headlessDispatcher: dispatch })
    const execute = vi.spyOn(service, 'runNow')
    const precheck = vi.spyOn(service, 'runPrecheck')
    runtime.setAutomationService(service)
    await expect(runNow(runtime, record.id, { selector: { kind: 'self' } })).rejects.toMatchObject({
      code: AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
    })
    expect(store.listAutomationRuns(record.id)).toEqual([])
    await expect(runNow(runtime, record.id)).rejects.toThrow(
      'Edit the automation and reselect its host before running it.: automation_target_removed'
    )
    expect(store.listAutomationRuns(record.id)).toMatchObject([
      {
        status: 'skipped_unavailable',
        trigger: 'manual',
        error: 'Edit the automation and reselect its host before running it.'
      }
    ])
    expect(store.listAutomationRuns(record.id)).toHaveLength(1)
    expect(execute).not.toHaveBeenCalled()
    expect(precheck).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('answers the caller with the conflict and still leaves the user a run record', async () => {
    const { store, runtime } = await makeManualRunRuntime()

    await expect(runNow(runtime, 'orphan-1')).rejects.toMatchObject({
      code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved
    })

    expect(store.listAutomationRuns('orphan-1')).toMatchObject([
      {
        status: 'skipped_unavailable',
        trigger: 'manual',
        error: 'The automation host is no longer registered, so this automation has nowhere to run.'
      }
    ])
  })

  // A stale caller must not fill run history with refusals the owner can still run.
  it('writes nothing when the refusal is about a stale caller, not a lost host', async () => {
    const { store, runtime } = await makeManualRunRuntime()
    const stale = {
      selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 6 }
    } as const satisfies AutomationOwnerPrecondition

    await expect(runNow(runtime, 'ssh-1-a', stale)).rejects.toMatchObject({
      code: AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
    })

    expect(store.listAutomationRuns('ssh-1-a')).toEqual([])
  })
})
