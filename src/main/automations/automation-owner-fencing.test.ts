import {
  closeTestStores,
  createSqliteTestStore,
  createStore as createFreshStore,
  testState
} from '../persistence/persistence-test-harness'
import { resetRetirementCollisionKeyCacheForTests } from '../workspaces/removal/retirement/worktree-name-retirement'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../shared/automation-owner-conflict'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'

let hasCreatedStoreInCase = false

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

const REPOS: Repo[] = [
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

const TARGETS: SshTarget[] = [
  { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me', generation: 7 }
] as SshTarget[]

const AUTOMATIONS: Automation[] = [
  automation({ id: 'local-1', name: 'A local' }),
  automation({
    id: 'ssh-1-a',
    name: 'B ssh',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-1',
    executionTargetGeneration: 7
  }),
  automation({
    id: 'orphan-1',
    name: 'C orphan',
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-gone',
    executionTargetGeneration: 3,
    enabled: false
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
      sshTargetGenerationCounter: 7,
      automations: AUTOMATIONS
    }),
    'utf-8'
  )
  if (!hasCreatedStoreInCase) {
    hasCreatedStoreInCase = true
    return createFreshStore()
  }
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store } = await import('../persistence/loading-store/store')
  const { initDataPath } = await import('../persistence/loading-store/user-data-path')
  initDataPath()
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

beforeEach(() => {
  hasCreatedStoreInCase = false
  resetRetirementCollisionKeyCacheForTests()
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-fencing-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('owner-fenced mutations', () => {
  it('refuses an update, delete, and dispatch fenced on a stale generation', async () => {
    const store = await createStore()
    const stale = { selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 6 } } as const
    const conflict = expect.objectContaining({
      code: AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
    })
    expect(() =>
      store.updateAutomation('ssh-1-a', { enabled: false }, { expectedOwner: stale })
    ).toThrowError(conflict)
    expect(() => store.deleteAutomation('ssh-1-a', { expectedOwner: stale })).toThrowError(conflict)
    expect(() =>
      store.assertAutomationOwnerFence({
        id: 'ssh-1-a',
        expectedOwner: stale,
        operation: 'execute'
      })
    ).toThrowError(conflict)
    expect(store.listAutomations().find((entry) => entry.id === 'ssh-1-a')?.enabled).toBe(true)
  })

  it('refuses an ownerless mutation of a generation-bearing SSH record', async () => {
    const store = await createStore()
    const required = expect.objectContaining({
      code: AUTOMATION_OWNER_CONFLICT_CODES.fencingRequired
    })
    expect(() => store.updateAutomation('ssh-1-a', { enabled: false })).toThrowError(required)
    expect(() => store.deleteAutomation('ssh-1-a')).toThrowError(required)
    expect(() =>
      store.assertAutomationOwnerFence({ id: 'ssh-1-a', operation: 'execute' })
    ).toThrowError(required)
    expect(store.listAutomations().find((entry) => entry.id === 'ssh-1-a')?.enabled).toBe(true)
    expect(store.listAutomations()).toHaveLength(3)
  })
})
