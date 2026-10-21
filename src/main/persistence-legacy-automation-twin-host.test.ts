import { closeTestStores, createStore, testState, writeDataFile } from './persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation } from '../shared/automations-types'
import type { Repo } from '../shared/repo-types'
import { getDefaultPersistedState } from '../shared/constants'
import { resolveAutomationRunTarget } from './automations/run-target-resolution'
import { AutomationService } from './automations/service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const localRow: Repo = {
  id: 'twin',
  path: '/laptop/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}
const sshRow: Repo = {
  id: 'twin',
  path: '/remote/twin',
  displayName: 'Twin',
  badgeColor: '#000',
  addedAt: 2,
  kind: 'git',
  connectionId: 'ssh-1'
}

function legacyAutomation(overrides: Partial<Automation> = {}): Record<string, unknown> {
  // Pre-host-context records stored only the repo id in `projectId`.
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

  it('does not guess a host for the record at load', () => {
    seed([localRow, sshRow], legacyAutomation())
    const store = createStore()

    expect(storedAutomation(store).runContext ?? null).toBeNull()
  })

  it.each([
    ['local row first', [localRow, sshRow]],
    ['SSH row first', [sshRow, localRow]]
  ])('refuses to run and tells the user to pick the host (%s)', (_label, repos) => {
    seed(repos, legacyAutomation({ runContext: null }))
    const store = createStore()

    const target = resolveAutomationRunTarget(store, storedAutomation(store))

    expect(target).toEqual({
      ok: false,
      error: expect.stringContaining('Open the automation and pick the host')
    })
    expect(storedAutomation(store).runContext ?? null).toBeNull()
  })

  it('captures the only host on its first run, which still launches, and keeps it', async () => {
    seed([localRow], legacyAutomation({ runContext: null }))
    const store = createStore()
    const send = vi.fn()
    const service = new AutomationService(store, { tickMs: 60_000 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reads only isDestroyed and send.
    service.setWebContents({ isDestroyed: () => false, send } as never)
    service.setRendererReady()

    const run = await service.runNow('legacy-1')

    expect(run.status).toBe('dispatching')
    expect(send).toHaveBeenCalledWith('automations:dispatchRequested', expect.any(Object))
    const stamped = storedAutomation(store).runContext
    expect(stamped).toMatchObject({ hostId: 'local', repoId: 'twin', path: '/laptop/twin' })

    await closeTestStores()
    const reloaded = createStore()
    expect(storedAutomation(reloaded).runContext).toEqual(stamped)
  })

  it('does not capture a host from a path that only reports a refusal', async () => {
    seed([localRow], legacyAutomation({ runContext: null }))
    const store = createStore()
    const service = new AutomationService(store, { tickMs: 60_000 })

    await service.recordRefusedRun('legacy-1')

    expect(storedAutomation(store).runContext ?? null).toBeNull()
  })

  it('keeps an existing-workspace record uncaptured when capture would move its folder', async () => {
    seed(
      [localRow],
      legacyAutomation({
        runContext: null,
        workspaceMode: 'existing',
        workspaceId: 'twin::/laptop/twin-feature'
      })
    )
    const store = createStore()
    const service = new AutomationService(store, { tickMs: 60_000 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reads only isDestroyed and send.
    service.setWebContents({ isDestroyed: () => false, send: vi.fn() } as never)
    service.setRendererReady()

    await service.runNow('legacy-1')

    expect(storedAutomation(store).runContext ?? null).toBeNull()
    expect(resolveAutomationRunTarget(store, storedAutomation(store))).toMatchObject({
      ok: true,
      cwd: '/laptop/twin-feature'
    })
  })
})
