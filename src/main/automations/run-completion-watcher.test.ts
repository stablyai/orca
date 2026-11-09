import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Repo } from '../../shared/repo-types'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
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
