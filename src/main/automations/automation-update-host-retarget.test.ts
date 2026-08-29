/**
 * An update may not move a record to another host unless it was asked to.
 *
 * Pause/resume stay enabled on orphans on purpose, so a plain `{ enabled }`
 * update is the one mutation an unrunnable record still accepts. Re-deriving the
 * execution target from the owning repo on that path re-adopts the record onto
 * whatever registration the repo points at today: the user pauses an orphan and
 * silently gets a healthy, dispatchable automation on a host they never chose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import { AUTOMATION_ORPHAN_ISSUES } from '../../shared/automation-list-scope'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../shared/automation-owner-conflict'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 'a1',
    name: 'Nightly',
    prompt: 'go',
    precheck: null,
    agentId: 'claude',
    projectId: 'repo-readded',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-old',
    executionTargetGeneration: 4,
    schedulerOwner: 'ssh_bridge',
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

const REPOS: Repo[] = [
  // Re-adoption re-pointed this repo onto the freshly minted target.
  {
    id: 'repo-readded',
    path: '/remote',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 1,
    connectionId: 'ssh-new'
  },
  // Same target id back with a new registration: the repo resolves, the capture does not.
  {
    id: 'repo-same-id',
    path: '/remote2',
    displayName: 'Remote 2',
    badgeColor: '#000',
    addedAt: 2,
    connectionId: 'ssh-box'
  },
  { id: 'repo-local', path: '/local', displayName: 'Local', badgeColor: '#000', addedAt: 3 }
] as Repo[]

const TARGETS: SshTarget[] = [
  { id: 'ssh-new', label: 'Box', host: 'box', port: 22, username: 'me', generation: 7 },
  { id: 'ssh-box', label: 'Box 2', host: 'box2', port: 22, username: 'me', generation: 9 }
] as SshTarget[]

const AUTOMATIONS: Automation[] = [
  automation({ id: 'stranded' }),
  automation({
    id: 'replaced',
    projectId: 'repo-same-id',
    executionTargetId: 'ssh-box',
    executionTargetGeneration: 4
  }),
  // Its project is local now, so re-deriving would strip the capture and call it Self.
  automation({
    id: 'local-project',
    projectId: 'repo-local',
    schedulerOwner: 'local_host_service'
  }),
  automation({
    id: 'healthy',
    projectId: 'repo-same-id',
    executionTargetId: 'ssh-box',
    executionTargetGeneration: 9
  })
]

async function createStore() {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      repos: REPOS,
      sshTargets: TARGETS,
      sshTargetGenerationCounter: 9,
      automations: AUTOMATIONS
    }),
    'utf-8'
  )
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

type Store = Awaited<ReturnType<typeof createStore>>

function storedTarget(record: Automation) {
  return {
    type: record.executionTargetType,
    id: record.executionTargetId,
    generation: record.executionTargetGeneration
  }
}

function projectedSelector(store: Store, id: string) {
  return store.listAutomationsForScope().items.find((item) => item.automationId === id)?.selector
}

const ORPHAN = { selector: { kind: 'orphan' } } as const

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-retarget-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('pausing an orphan never re-adopts it', () => {
  it('keeps the dead capture when the repo was re-pointed at a new registration', async () => {
    const store = await createStore()
    expect(projectedSelector(store, 'stranded')).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetMissing
    })

    const paused = store.updateAutomation('stranded', { enabled: false }, { expectedOwner: ORPHAN })

    expect(paused.enabled).toBe(false)
    expect(storedTarget(paused)).toEqual({ type: 'ssh', id: 'ssh-old', generation: 4 })
    expect(projectedSelector(store, 'stranded')).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetMissing
    })
  })

  it('leaves the record unrunnable on the host the repo now points at', async () => {
    const store = await createStore()

    store.updateAutomation('stranded', { enabled: false }, { expectedOwner: ORPHAN })

    // Run Now against the re-added registration must still be refused; a pause is not a re-adoption.
    expect(() =>
      store.assertAutomationOwnerFence({
        id: 'stranded',
        expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-new', targetGeneration: 7 } },
        operation: 'execute'
      })
    ).toThrowError(expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved }))
  })

  it('keeps the stale generation when the same target id came back re-registered', async () => {
    const store = await createStore()
    expect(projectedSelector(store, 'replaced')).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced
    })

    const paused = store.updateAutomation('replaced', { enabled: false }, { expectedOwner: ORPHAN })

    expect(storedTarget(paused)).toEqual({ type: 'ssh', id: 'ssh-box', generation: 4 })
    expect(projectedSelector(store, 'replaced')).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetReplaced
    })
  })

  it('does not strip the capture and rewrite an orphan to Self', async () => {
    const store = await createStore()

    const paused = store.updateAutomation(
      'local-project',
      { enabled: false },
      { expectedOwner: ORPHAN }
    )

    expect(storedTarget(paused)).toEqual({ type: 'ssh', id: 'ssh-old', generation: 4 })
    expect(projectedSelector(store, 'local-project')).toEqual({
      kind: 'orphan',
      issue: AUTOMATION_ORPHAN_ISSUES.targetMissing
    })
  })
})

describe('an update that was asked to move still moves', () => {
  it('re-derives from an explicitly supplied project', async () => {
    const store = await createStore()

    const moved = store.updateAutomation(
      'healthy',
      { projectId: 'repo-readded' },
      {
        expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-box', targetGeneration: 9 } },
        destination: { selector: { kind: 'ssh', targetId: 'ssh-new', targetGeneration: 7 } }
      }
    )

    expect(storedTarget(moved)).toEqual({ type: 'ssh', id: 'ssh-new', generation: 7 })
  })

  it('leaves a fenced in-place edit on its own host', async () => {
    const store = await createStore()

    const renamed = store.updateAutomation(
      'healthy',
      { name: 'Renamed' },
      { expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-box', targetGeneration: 9 } } }
    )

    expect(renamed.name).toBe('Renamed')
    expect(storedTarget(renamed)).toEqual({ type: 'ssh', id: 'ssh-box', generation: 9 })
  })
})
