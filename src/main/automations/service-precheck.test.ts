import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import { AutomationService } from './service'
import { runHeadlessAutomationDispatch } from './headless-dispatch-runner'
import { createAutomationRunWriter } from './automation-run-writer'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const runAutomationPrecheckMock = vi.hoisted(() => vi.fn())
const testState = { dir: '' }

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

vi.mock('./precheck-runner', () => ({
  runAutomationPrecheck: runAutomationPrecheckMock
}))

async function createStore() {
  vi.resetModules()
  installFakeAppEnvironment({ getPath: () => testState.dir })
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

/** Simulate registry drift after a record was stored; the create path derives contexts itself. */
function mutateDataFile(
  mutate: (state: {
    automations: Record<string, unknown>[]
    automationRuns: Record<string, unknown>[]
  }) => void
): void {
  const file = join(testState.dir, 'orca-data.json')
  const state = JSON.parse(readFileSync(file, 'utf-8'))
  mutate(state)
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
}

describe('AutomationService prechecks', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    runAutomationPrecheckMock.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('runs scheduled prechecks in the target repo before dispatch', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo({ path: '/repo/path' }))
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
    const precheckResult = {
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
    }
    runAutomationPrecheckMock.mockResolvedValue(precheckResult)
    const service = new AutomationService(store, { tickMs: 60_000 })

    const result = await service.runPrecheck(automation.id, run.id)

    expect(result).toEqual(precheckResult)
    expect(runAutomationPrecheckMock).toHaveBeenCalledWith({
      precheck: {
        command: 'test -f ready',
        timeoutSeconds: 30
      },
      target: {
        type: 'local',
        cwd: '/repo/path'
      }
    })
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

  it('does not run prechecks for manual dispatches', async () => {
    vi.setSystemTime(new Date('2026-05-13T08:00:00Z'))
    const store = await createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Manual check',
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
    const run = store.createAutomationRun(automation, Date.now(), 'manual')
    const service = new AutomationService(store, { tickMs: 60_000 })

    await expect(service.runPrecheck(automation.id, run.id)).resolves.toBeNull()
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
      headlessDispatcher
    })
    const run = store.createAutomationRun(automation, Date.now(), 'scheduled')

    await runHeadlessAutomationDispatch({
      automation,
      run,
      target: { ok: true, cwd: '/repo', repo: store.getRepo('r1')! },
      dispatcher: headlessDispatcher,
      runs: createAutomationRunWriter(store, null),
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
})
