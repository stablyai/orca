import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { AutomationService } from './service'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'
import { runNowSettled } from './automation-run-now-settled.test-fixture'

const ipcHandlers = new Map<string, (event: unknown, args: unknown) => unknown>()

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      ipcHandlers.set(channel, handler)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

type TestStore = Awaited<ReturnType<typeof createStore>>

function createAutomation(store: TestStore): Automation {
  store.addRepo(makeRepo())
  return store.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'existing',
    workspaceId: 'wt1',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date('2026-05-12T00:00:00Z').getTime()
  })
}

const LAUNCH_TARGET = {
  workspaceId: 'wt1',
  terminalSessionId: 'tab-1',
  terminalPaneKey: 'tab-1:11111111-2222-4333-8444-555555555555',
  terminalPtyId: 'pty-1'
}

function readRun(store: TestStore, automationId: string, runId: string): AutomationRun {
  const run = store.listAutomationRuns(automationId).find((entry) => entry.id === runId)
  if (!run) {
    throw new Error('run missing')
  }
  return run
}

function createObserver(
  observe: (signal: AbortSignal) => Promise<AutomationRunCompletionObservation>,
  resolveRunTerminal: (run: AutomationRun) => string | null = (run) =>
    run.terminalPaneKey ? 'handle-1' : null
): AutomationRunTerminalObserver {
  return {
    resolveRunTerminal,
    observeCompletion: (_handle, { signal }) => observe(signal)
  }
}

describe('authority-owned automation run completion', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-completion-'))
    ipcHandlers.clear()
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reconciles stranded runs on startup without claiming completion', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    store.updateAutomation(automation.id, { enabled: false })
    const pendingManual = store.createAutomationRun(automation, 3_000, 'manual')
    const pendingScheduled = store.createAutomationRun(automation, 4_000, 'scheduled')
    const dispatched = store.createAutomationRun(automation, 1_000, 'manual')
    store.updateAutomationRun({
      runId: dispatched.id,
      status: 'dispatched',
      ...LAUNCH_TARGET,
      error: null
    })
    const dispatching = store.createAutomationRun(automation, 2_000, 'manual')
    store.updateAutomationRun({
      runId: dispatching.id,
      status: 'dispatching',
      workspaceId: 'wt1',
      error: null
    })

    const service = new AutomationService(store, {
      terminalObserver: createObserver(
        async () => ({ status: 'completed' }),
        () => null
      ),
      terminalLauncher: { launch: async () => ({ ...LAUNCH_TARGET }), available: () => true }
    })
    vi.useFakeTimers()
    service.start()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(readRun(store, automation.id, dispatched.id).status).toBe('dispatch_failed')
    expect(readRun(store, automation.id, dispatching.id).status).toBe('dispatch_failed')
    expect(readRun(store, automation.id, dispatched.id).error).toContain('terminal')
    expect(readRun(store, automation.id, dispatching.id).error).toContain('agent started')
    for (const pending of [pendingManual, pendingScheduled]) {
      expect(readRun(store, automation.id, pending.id)).toMatchObject({
        status: 'dispatch_failed',
        error: 'Orca stopped before this run could launch.'
      })
    }
    service.stop()
    vi.useRealTimers()
  })

  it('persists the terminal status once when another writer wins the race', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    let resolveObservation: ((value: AutomationRunCompletionObservation) => void) | null = null
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      terminalLauncher: { launch: async () => ({ ...LAUNCH_TARGET }), available: () => true },
      terminalObserver: createObserver(
        () =>
          new Promise<AutomationRunCompletionObservation>((resolve) => {
            resolveObservation = resolve
          })
      )
    })

    const run = await runNowSettled(service, store, automation.id)
    await vi.waitFor(() => expect(resolveObservation).not.toBeNull())

    await service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      ...LAUNCH_TARGET,
      error: null
    })
    const afterFirst = readRun(store, automation.id, run.id)
    const writeSpy = vi.spyOn(store, 'updateAutomationRun')

    resolveObservation!({ status: 'dispatch_failed', error: 'watcher lost the terminal' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writeSpy).not.toHaveBeenCalled()
    const afterWatcher = readRun(store, automation.id, run.id)
    expect(afterWatcher.status).toBe('completed')
    expect(afterWatcher.error).toBeNull()
    expect(afterWatcher.usage).toEqual(afterFirst.usage)
    writeSpy.mockRestore()
    service.stop()
  })

  it('disposes watchers on stop', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const aborted: boolean[] = []
    const service = new AutomationService(store, {
      allowRemoteHostScheduling: true,
      terminalLauncher: { launch: async () => ({ ...LAUNCH_TARGET }), available: () => true },
      terminalObserver: createObserver(
        (signal) =>
          new Promise<AutomationRunCompletionObservation>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted.push(true)
              reject(new Error('aborted'))
            })
          })
      )
    })

    const run = await runNowSettled(service, store, automation.id)
    service.stop()
    await vi.waitFor(() => expect(aborted).toEqual([true]))
    expect(readRun(store, automation.id, run.id).status).toBe('dispatched')
  })
})
