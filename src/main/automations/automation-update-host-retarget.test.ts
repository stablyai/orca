import {
  closeTestStores,
  createSqliteTestStore,
  createStore as createFreshStore,
  testState
} from '../persistence/persistence-test-harness'
import { resetRetirementCollisionKeyCacheForTests } from '../workspaces/removal/retirement/worktree-name-retirement'
/** Pausing an orphan must preserve its captured host rather than re-adopting today’s repo host. */
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
  {
    id: 'repo-readded',
    path: '/remote',
    displayName: 'Remote',
    badgeColor: '#000',
    addedAt: 1,
    connectionId: 'ssh-new'
  },
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
  // Re-deriving from this local project would silently discard the SSH capture.
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

const ORPHAN = { selector: { kind: 'orphan' } } as const

beforeEach(() => {
  hasCreatedStoreInCase = false
  resetRetirementCollisionKeyCacheForTests()
  testState.dir = mkdtempSync(join(tmpdir(), 'automation-retarget-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
  vi.resetModules()
})

describe('pausing an orphan never re-adopts it', () => {
  it('leaves the record unrunnable on the host the repo now points at', async () => {
    const store = await createStore()

    store.updateAutomation('stranded', { enabled: false }, { expectedOwner: ORPHAN })

    expect(() =>
      store.assertAutomationOwnerFence({
        id: 'stranded',
        expectedOwner: { selector: { kind: 'ssh', targetId: 'ssh-new', targetGeneration: 7 } },
        operation: 'execute'
      })
    ).toThrowError(expect.objectContaining({ code: AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged }))
  })
})
