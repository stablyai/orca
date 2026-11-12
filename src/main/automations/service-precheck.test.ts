import {
  closeTestStores,
  createSqliteTestStore,
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
