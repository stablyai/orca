import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import { AutomationService } from './service'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const testState = { dir: '' }
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

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('brings a headless dispatched run to a terminal state with no renderer attached', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const service = new AutomationService(store, {
      // Why: a dispatcher without a completion promise is exactly the case that
      // used to strand a run at 'dispatched' for the process lifetime.
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
      terminalObserver: createObserver(async () => ({ status: 'completed', error: null }))
    })

    const run = await service.runNow(automation.id)
    expect(run.status).toBe('dispatched')
    await vi.waitFor(() => {
      expect(readRun(store, automation.id, run.id).status).toBe('completed')
    })
    service.stop()
  })

  it('leaves a headless dispatched run alone when the authority cannot observe it', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const service = new AutomationService(store, {
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
      terminalObserver: createObserver(
        async () => ({ status: 'completed' }),
        () => null
      )
    })

    const run = await service.runNow(automation.id)
    expect(readRun(store, automation.id, run.id).status).toBe('dispatched')
    service.stop()
  })

  /**
   * The throws on this path carry transport tokens, not sentences. Every other
   * refusal in run history is one fixed sentence, so leaking `terminal_handle_stale`
   * into the row a user reads breaks the only convention that surface has.
   */
  it('reports a failed observation in the same fixed sentence every other refusal uses', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = new AutomationService(store, {
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
      terminalObserver: createObserver(async () => {
        throw new Error('terminal_handle_stale')
      })
    })

    const run = await service.runNow(automation.id)
    await vi.waitFor(() => {
      expect(readRun(store, automation.id, run.id).status).toBe('dispatch_failed')
    })

    expect(readRun(store, automation.id, run.id).error).toBe(
      'Orca stopped watching this run before it reported completion.'
    )
    // The token is still recoverable where it is actually useful.
    expect(logged.mock.calls.flat().map(String).join(' ')).toContain('terminal_handle_stale')
    logged.mockRestore()
    service.stop()
  })

  it('reconciles stranded runs on startup without claiming completion', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
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
      )
    })
    vi.useFakeTimers()
    service.start()
    // Stranding needs a surface that reported ready and still cannot find the pane.
    service.setRendererReady()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)

    expect(readRun(store, automation.id, dispatched.id).status).toBe('dispatch_failed')
    expect(readRun(store, automation.id, dispatching.id).status).toBe('dispatch_failed')
    expect(readRun(store, automation.id, dispatched.id).error).toContain('terminal')
    expect(readRun(store, automation.id, dispatching.id).error).toContain('agent started')
    service.stop()
    vi.useRealTimers()
  })

  it('re-attaches a watcher on startup when the session survived', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const run = store.createAutomationRun(automation, 1_000, 'manual')
    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      ...LAUNCH_TARGET,
      error: null
    })

    let resolveObservation: ((value: AutomationRunCompletionObservation) => void) | null = null
    const service = new AutomationService(store, {
      terminalObserver: createObserver(
        () =>
          new Promise<AutomationRunCompletionObservation>((resolve) => {
            resolveObservation = resolve
          })
      )
    })
    service.start()

    await vi.waitFor(() => expect(resolveObservation).not.toBeNull())
    expect(readRun(store, automation.id, run.id).status).toBe('dispatched')
    resolveObservation!({ status: 'completed', error: null })
    await vi.waitFor(() => {
      expect(readRun(store, automation.id, run.id).status).toBe('completed')
    })
    service.stop()
  })

  it('persists the terminal status once when the renderer wins the race', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    let resolveObservation: ((value: AutomationRunCompletionObservation) => void) | null = null
    const service = new AutomationService(store, {
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
      terminalObserver: createObserver(
        () =>
          new Promise<AutomationRunCompletionObservation>((resolve) => {
            resolveObservation = resolve
          })
      )
    })

    const run = await service.runNow(automation.id)
    await vi.waitFor(() => expect(resolveObservation).not.toBeNull())

    // The renderer's own dispatch observer reports first.
    await service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      ...LAUNCH_TARGET,
      error: null
    })
    const afterRenderer = readRun(store, automation.id, run.id)
    const writeSpy = vi.spyOn(store, 'updateAutomationRun')

    resolveObservation!({ status: 'dispatch_failed', error: 'watcher lost the terminal' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writeSpy).not.toHaveBeenCalled()
    const afterWatcher = readRun(store, automation.id, run.id)
    expect(afterWatcher.status).toBe('completed')
    expect(afterWatcher.error).toBeNull()
    expect(afterWatcher.usage).toEqual(afterRenderer.usage)
    writeSpy.mockRestore()
    service.stop()
  })

  it('disposes watchers on stop', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const aborted: boolean[] = []
    const service = new AutomationService(store, {
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
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

    const run = await service.runNow(automation.id)
    service.stop()
    await vi.waitFor(() => expect(aborted).toEqual([true]))
    expect(readRun(store, automation.id, run.id).status).toBe('dispatched')
  })

  it('keeps a run dispatched against an authority with no completion watching', async () => {
    // Why: the New client | Old runtime matrix row — the old authority publishes
    // no event and reconciles nothing, so the client must not crash or invent a
    // terminal status; TTL/focus revalidation stays the only refresh path.
    const store = await createStore()
    const automation = createAutomation(store)
    const publish = vi.fn()
    const service = new AutomationService(store, {
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
      onAutomationsChanged: publish
    })

    const run = await service.runNow(automation.id)
    service.start()
    await Promise.resolve()
    expect(readRun(store, automation.id, run.id).status).toBe('dispatched')
    service.stop()
  })
})

describe('automationsChanged publication', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-events-'))
    ipcHandlers.clear()
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('publishes run and usage changes after the write is persisted', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const seen: { payload: AutomationsChangedPayload; status: string | undefined }[] = []
    const service = new AutomationService(store, {
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
      onAutomationsChanged: (payload) => {
        seen.push({
          payload,
          status: store.listAutomationRuns(automation.id)[0]?.status
        })
      }
    })

    const run = await service.runNow(automation.id)
    expect(seen.map((entry) => entry.payload.reason)).toEqual(['run', 'run'])
    expect(seen.at(-1)?.status).toBe('dispatched')

    await service.markDispatchResult({
      runId: run.id,
      status: 'completed',
      ...LAUNCH_TARGET,
      error: null
    })
    expect(seen.map((entry) => entry.payload.reason)).toEqual(['run', 'run', 'run', 'usage'])
    expect(seen.at(-1)?.status).toBe('completed')
    // Every run/usage write names its own host, so one automation's run cannot
    // invalidate the rest of the authority.
    expect(seen.every((entry) => entry.payload.selector?.kind === 'self')).toBe(true)
    service.stop()
  })

  // Definition-change publication from the shared runtime methods is covered by
  // src/main/runtime/automation-change-publication.test.ts against the real store.

  it('changes nothing for a consumer that ignores the unknown event type', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    // An old client's event switch has no automationsChanged branch at all.
    const oldClientState = { repoRefreshes: 0 }
    const service = new AutomationService(store, {
      headlessDispatcher: async () => ({ ...LAUNCH_TARGET }),
      onAutomationsChanged: (payload) => {
        if ((payload as { type?: string }).type === 'reposChanged') {
          oldClientState.repoRefreshes += 1
        }
      }
    })

    const run = await service.runNow(automation.id)
    expect(oldClientState.repoRefreshes).toBe(0)
    expect(readRun(store, automation.id, run.id).status).toBe('dispatched')
    service.stop()
  })
})
