import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson,
  createStore as createFreshStore,
  testState
} from '../persistence/persistence-test-harness'
import { resetRetirementCollisionKeyCacheForTests } from '../workspaces/removal/retirement/worktree-name-retirement'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import { AutomationService } from './service'
import { runAutomationLaunch } from './automation-launch-runner'
import { createAutomationRunWriter } from './automation-run-writer'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import type * as PrecheckRunner from './precheck-runner'

const runAutomationPrecheckMock = vi.hoisted(() => vi.fn())
let hasCreatedStoreInCase = false

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./precheck-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof PrecheckRunner>()),
  runAutomationPrecheck: runAutomationPrecheckMock
}))

async function createStore() {
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

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

/** Inject persisted drift that normal creation would resolve. */
function mutateDataFile(
  mutate: (state: {
    automations: Record<string, unknown>[]
    automationRuns: Record<string, unknown>[]
  }) => void
): void {
  const file = join(testState.dir, 'orca-data.json')
  const state = JSON.parse(readPersistedStateJson(file))
  mutate(state)
  writePersistedStateJson(file, JSON.stringify(state))
}

describe('AutomationService prechecks', () => {
  beforeEach(() => {
    hasCreatedStoreInCase = false
    resetRetirementCollisionKeyCacheForTests()
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    runAutomationPrecheckMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('does not run scheduled prechecks when the selected host setup is stale', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo({ path: '/repo/current' }))
    const setup = store.getProjectHostSetups()[0]!
    const automation = store.createAutomation({
      name: 'Conditional check',
      prompt: 'Check the repo',
      precheck: {
        command: 'test -f ready',
        timeoutSeconds: 30
      },
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-14T00:00:00Z').getTime()
    })
    const run = store.createAutomationRun(automation, Date.now(), 'scheduled')
    const staleRunContext = {
      kind: 'workspace-run',
      projectId: setup.projectId,
      hostId: setup.hostId,
      projectHostSetupId: setup.id,
      repoId: setup.repoId,
      path: '/repo/old'
    }
    mutateDataFile((state) => {
      state.automations[0].runContext = staleRunContext
      state.automationRuns[0].runContext = staleRunContext
    })
    const reloaded = await createStore()
    const service = new AutomationService(reloaded, { tickMs: 60_000 })

    const result = await service.runPrecheck(automation.id, run.id)

    expect(result).toMatchObject({
      command: 'test -f ready',
      exitCode: null,
      error: 'Project path for the selected automation host has changed.'
    })
    expect(runAutomationPrecheckMock).not.toHaveBeenCalled()
  })

  it('honors scheduled prechecks before headless dispatch', async () => {
    vi.setSystemTime(new Date('2026-05-12T08:59:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Conditional remote check',
      prompt: 'Check the repo',
      precheck: {
        command: 'test -f ready',
        timeoutSeconds: 30
      },
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00Z').getTime()
    })
    runAutomationPrecheckMock.mockResolvedValue({
      command: 'test -f ready',
      exitCode: 1,
      timedOut: false,
      durationMs: 5,
      stdout: '',
      stderr: 'missing',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
      startedAt: Date.now(),
      completedAt: Date.now()
    })
    const headlessDispatcher = vi.fn()
    const service = new AutomationService(store, {
      tickMs: 60_000,
      allowRemoteHostScheduling: true,
      terminalLauncher: { launch: headlessDispatcher, available: () => true }
    })
    const run = store.createAutomationRun(automation, Date.now(), 'scheduled')

    await runAutomationLaunch({
      automation,
      run,
      target: { ok: true, cwd: '/repo', repo: store.getRepo('r1')! },
      dispatcher: headlessDispatcher,
      transition: (result) => ({
        applied: true,
        run: createAutomationRunWriter(store, null).updateRun({ runId: run.id, ...result })
      }),
      runPrecheck: () => service.runPrecheck(automation.id, run.id),
      markDispatchResult: (result) => service.markDispatchResult(result),
      watchRun: () => {}
    })

    expect(headlessDispatcher).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)[0]).toMatchObject({
      status: 'skipped_precheck',
      error: 'Precheck exited with code 1.'
    })
  })

  it('answers Run Now at once and launches it once after a scheduled run still in its precheck', async () => {
    vi.setSystemTime(new Date('2026-05-12T08:59:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Reused session',
      prompt: 'Check the repo',
      precheck: { command: 'test -f ready', timeoutSeconds: 30 },
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00Z').getTime()
    })
    let passPrecheck = (): void => {}
    runAutomationPrecheckMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          passPrecheck = () =>
            resolve({
              command: 'test -f ready',
              exitCode: 0,
              timedOut: false,
              durationMs: 5,
              stdout: '',
              stderr: '',
              stdoutTruncated: false,
              stderrTruncated: false,
              error: null,
              startedAt: Date.now(),
              completedAt: Date.now()
            })
        })
    )
    const dispatched: string[] = []
    const service = new AutomationService(store, {
      tickMs: 60_000,
      allowRemoteHostScheduling: true,
      terminalLauncher: {
        launch: async ({ run }) => {
          dispatched.push(run.trigger)
          return { workspaceId: 'wt-1', terminalSessionId: null }
        },
        available: () => true
      }
    })
    vi.setSystemTime(automation.nextRunAt + 30_000)
    service.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(runAutomationPrecheckMock).toHaveBeenCalledTimes(1)

    // The saved row answers at once; the launch waits its turn in the lane.
    const manual = await service.runNow(automation.id)
    expect(manual.status).toBe('pending')
    expect(dispatched).toEqual([])

    passPrecheck()
    await service.runInAutomationLane(automation.id, async () => undefined)
    expect(dispatched).toEqual(['scheduled', 'manual'])
    expect(
      store.listAutomationRuns(automation.id).find((run) => run.id === manual.id)?.status
    ).toBe('dispatched')
    service.stop()
  })
})
