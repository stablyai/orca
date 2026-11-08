import { closeTestStores, createStore, testState, writeDataFile } from '../persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { Repo } from '../../../shared/repo-types'
import { getDefaultPersistedState } from '../../../shared/constants'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}

function legacyAutomation(overrides: Partial<Automation> = {}): Record<string, unknown> {
  // Legacy projectId values named a repo ID without host context.
  return {
    id: 'legacy-1',
    name: 'Nightly',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: 'twin',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: true,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function seed(repos: Repo[], automation: Record<string, unknown>): void {
  writeDataFile({
    ...getDefaultPersistedState(testState.dir),
    repos,
    sshTargets: [{ id: 'ssh-1', label: 'Builder', host: 'builder', port: 22, username: 'u' }],
    automations: [automation]
  })
}

function storedAutomation(store: ReturnType<typeof createStore>): Automation {
  const automation = store.listAutomations().find((entry) => entry.id === 'legacy-1')
  if (!automation) {
    throw new Error('legacy automation missing')
  }
  return automation
}

describe('legacy automation on a repo id two hosts share', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-legacy-twin-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('preserves explicit null contexts across an unrelated saved edit and restart', async () => {
    seed([localRow], legacyAutomation({ runContext: null, sourceContext: null }))
    let store = createStore()
    store.updateAutomation('legacy-1', { name: 'Renamed', enabled: false })
    expect(storedAutomation(store)).toMatchObject({
      runContext: null,
      sourceContext: null,
      enabled: false
    })
    await closeTestStores()
    store = createStore()
    expect(storedAutomation(store)).toMatchObject({
      runContext: null,
      sourceContext: null,
      name: 'Renamed',
      enabled: false
    })
  })
})
