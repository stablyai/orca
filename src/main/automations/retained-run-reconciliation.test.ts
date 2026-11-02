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

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  ipcMain: { handle: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

type TestStore = Awaited<ReturnType<typeof createStore>>

const makeRepo = (): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'test',
  badgeColor: '#fff',
  addedAt: 1
})

const LAUNCH_TARGET = {
  workspaceId: 'wt1',
  terminalSessionId: 'tab-1',
  terminalPaneKey: 'tab-1:11111111-2222-4333-8444-555555555555',
  terminalPtyId: 'pty-1'
}

const AFTER_SETTLE_MS = 10 * 60 * 1000

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

function retainDispatchedRun(store: TestStore, automation: Automation): AutomationRun {
  const run = store.createAutomationRun(automation, Date.now() - 60_000, 'manual')
  return store.updateAutomationRun({
    runId: run.id,
    status: 'dispatched',
    ...LAUNCH_TARGET,
    error: null
  })
}

function readRun(store: TestStore, automationId: string, runId: string): AutomationRun {
  const run = store.listAutomationRuns(automationId).find((entry) => entry.id === runId)
  if (!run) {
    throw new Error('run missing')
  }
  return run
}

function createPaneSurface(): {
  observer: AutomationRunTerminalObserver
  mountPane: () => void
  settleObservation: (value: AutomationRunCompletionObservation) => void
  observedHandles: string[]
} {
  const state = { mounted: false }
  const observedHandles: string[] = []
  let resolveObservation: ((value: AutomationRunCompletionObservation) => void) | null = null
  return {
    observer: {
      resolveRunTerminal: (run) => (state.mounted && run.terminalPaneKey ? 'handle-1' : null),
      observeCompletion: (handle) => {
        observedHandles.push(handle)
        return new Promise<AutomationRunCompletionObservation>((resolve) => {
          resolveObservation = resolve
        })
      }
    },
    mountPane: () => {
      state.mounted = true
    },
    settleObservation: (value) => resolveObservation?.(value),
    observedHandles
  }
}

describe('reconciling retained runs against a graph that has not published yet', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-retained-run-'))
    vi.useFakeTimers()
    // Away from the automation's 09:00 UTC occurrence so timer advances stay inert.
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('does not fail a desktop-startup retained run while the window graph is empty', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const retained = retainDispatchedRun(store, automation)
    const surface = createPaneSurface()
    const service = new AutomationService(store, { terminalObserver: surface.observer })

    service.setWebContents({ isDestroyed: () => false } as never)
    service.start()
    await vi.advanceTimersByTimeAsync(AFTER_SETTLE_MS)

    expect(readRun(store, automation.id, retained.id).status).toBe('dispatched')
    expect(readRun(store, automation.id, retained.id).error).toBeNull()
    service.stop()
  })

  it('re-attaches to the run once the restored pane mounts seconds later', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const retained = retainDispatchedRun(store, automation)
    const surface = createPaneSurface()
    const service = new AutomationService(store, { terminalObserver: surface.observer })

    service.start()
    service.setRendererReady()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(surface.observedHandles).toEqual([])

    surface.mountPane()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(surface.observedHandles).toEqual(['handle-1'])

    surface.settleObservation({ status: 'completed', error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(readRun(store, automation.id, retained.id).status).toBe('completed')
    service.stop()
  })

  it('does not fail a serve-startup retained run whose host pane has not reattached', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const retained = retainDispatchedRun(store, automation)
    const surface = createPaneSurface()
    const service = new AutomationService(store, {
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
      terminalObserver: surface.observer
    })

    service.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(readRun(store, automation.id, retained.id).status).toBe('dispatched')

    surface.mountPane()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(surface.observedHandles).toEqual(['handle-1'])
    expect(readRun(store, automation.id, retained.id).status).toBe('dispatched')
    service.stop()
  })

  it('still closes out a run the ready surface cannot find after the settle window', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const retained = retainDispatchedRun(store, automation)
    const surface = createPaneSurface()
    const service = new AutomationService(store, { terminalObserver: surface.observer })

    service.start()
    service.setRendererReady()
    await vi.advanceTimersByTimeAsync(AFTER_SETTLE_MS)

    expect(readRun(store, automation.id, retained.id).status).toBe('dispatch_failed')
    expect(readRun(store, automation.id, retained.id).error).toBe(
      'Orca lost the terminal for this run before it reported completion.'
    )
    service.stop()
  })
})
