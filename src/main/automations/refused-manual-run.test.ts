/**
 * doc:94 pairs "return the typed `target_removed` conflict" with "record a
 * skipped-run reason". The scheduler already did both; a manual attempt used to
 * throw and write nothing, so the same automation left a row when a schedule
 * refused it and no trace at all when the user asked by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { getDefaultPersistedState } from '../../shared/constants'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../../shared/automation-owner-conflict'
import type { AutomationOwnerPrecondition } from '../../shared/automation-owner-precondition'
import { AutomationService } from './service'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }
const ipcHandlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      ipcHandlers.set(channel, handler)
    }
  },
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
    projectId: 'repo-ssh',
    executionTargetType: 'ssh',
    executionTargetId: 'ssh-1',
    executionTargetGeneration: 7,
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
  automation({ id: 'live-1' }),
  automation({ id: 'orphan-1', executionTargetId: 'ssh-gone', executionTargetGeneration: 3 })
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
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  const store = new Store()
  const service = new AutomationService(store, { tickMs: 60_000 })
  // Manual runs arrive over the shared runtime RPC surface for every transport.
  const { OrcaRuntimeService } = await import('../runtime/orca-runtime')
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setAutomationService(service)
  return { store, service, runtime }
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

describe('manual run refused before dispatch', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'automation-refused-manual-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('answers the caller with the conflict and still leaves the user a run record', async () => {
    const { store, runtime } = await createStore()

    await expect(runNow(runtime, 'orphan-1')).rejects.toMatchObject({
      code: AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved
    })

    // Same sentence the scheduler writes for this record, so run history reads
    // the same whether the refusal came from a schedule or from the user.
    expect(store.listAutomationRuns('orphan-1')).toMatchObject([
      {
        status: 'skipped_unavailable',
        trigger: 'manual',
        error: 'The automation host is no longer registered, so this automation has nowhere to run.'
      }
    ])
  })

  /**
   * `owner_changed` says the CALLER is stale, not that the record is unrunnable.
   * A client that re-reads the owner and retries would otherwise fill run history
   * with rows for runs the user never saw refused.
   */
  it('writes nothing when the refusal is about a stale caller, not a lost host', async () => {
    const { store, runtime } = await createStore()
    const stale = {
      selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 6 }
    } as const satisfies AutomationOwnerPrecondition

    await expect(runNow(runtime, 'live-1', stale)).rejects.toMatchObject({
      code: AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged
    })

    expect(store.listAutomationRuns('live-1')).toEqual([])
  })
})
