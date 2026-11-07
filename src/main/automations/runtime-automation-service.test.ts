import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createRuntimeAutomationService } from './runtime-automation-service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

type TestStore = Awaited<ReturnType<typeof createStore>>

const PANE = (name: string) => `tab-${name}:11111111-2222-4333-8444-555555555555`

function createAutomation(store: TestStore): Automation {
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'repo', badgeColor: '#fff', addedAt: 1 })
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

function retainRun(
  store: TestStore,
  automation: Automation,
  name: string,
  status: AutomationRun['status']
): AutomationRun {
  const run = store.createAutomationRun(
    automation,
    Date.now() + store.listAutomationRuns().length,
    'manual'
  )
  return store.updateAutomationRun({
    runId: run.id,
    status,
    workspaceId: 'wt1',
    terminalSessionId: `tab-${name}`,
    terminalPaneKey: PANE(name),
    terminalPtyId: `pty-${name}`,
    error: null
  })
}

/** This host's runtime with one live pane per run; every pane's agent stays busy. */
function fakeRuntime(focusedTabIds: string[] = []) {
  const handleOf = (paneKey: string) => `handle:${paneKey}`
  const runtime = {
    getAgentStatusRowsForPane: () => [],
    getAcceptedAgentReply: () => null,
    subscribeAgentStatusRowChanges: () => () => {},
    openedAgentSessionRecordStore: () => null,
    openAgentSessionRecordStore: vi.fn(() => new Promise(() => {})),
    getTerminalHandleForPaneKey: (paneKey: string) => handleOf(paneKey),
    getTerminalPtyIdForHandle: (handle: string) => `pty-${handle.split('tab-')[1]?.split(':')[0]}`,
    waitForTerminal: vi.fn((_handle: string) => new Promise(() => {})),
    readTerminal: async () => ({ tail: [] }),
    readTerminalClientUse: () => 'unused' as const,
    confirmTerminalShellAlone: async () => true,
    getWorkspaceSessionForWorktree: () => ({
      unifiedTabs: {
        wt1: focusedTabIds.map((id) => ({ id, lastFocusedAt: 1 }))
      }
    }),
    closeTerminal: vi.fn(async () => {}),
    canOpenRunTerminals: () => true,
    setAutomationService: () => {},
    notifyAutomationsChanged: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only these runtime members.
  return { runtime, service: runtime as unknown as OrcaRuntimeService }
}

const readRun = (store: TestStore, run: AutomationRun) =>
  store.listAutomationRuns(run.automationId).find((entry) => entry.id === run.id)

describe('runtime automation service', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-runtime-automation-service-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00Z'))
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reattaches a dispatched run after restart and strands one whose prompt was never confirmed', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const dispatched = retainRun(store, automation, 'x', 'dispatched')
    const dispatching = retainRun(store, automation, 'y', 'dispatching')
    const { runtime, service: host } = fakeRuntime()
    const service = createRuntimeAutomationService({
      store,
      runtime: host,
      allowRemoteHostScheduling: false
    })

    service.start()
    await vi.advanceTimersByTimeAsync(3 * 60_000)

    const watchedHandles = runtime.waitForTerminal.mock.calls.map((call) => call[0])
    expect(watchedHandles).toEqual([`handle:${PANE('x')}`])
    expect(readRun(store, dispatched)?.status).toBe('dispatched')
    expect(readRun(store, dispatching)).toMatchObject({
      status: 'dispatch_failed',
      error: 'Orca stopped before this run reported that its agent started.',
      terminalSessionId: 'tab-y',
      terminalPaneKey: PANE('y'),
      terminalPtyId: 'pty-y'
    })
    service.stop()
  })

  it('keeps a finished run terminal the user has focused and closes an untouched one', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const focused = retainRun(store, automation, 'seen', 'completed')
    const untouched = retainRun(store, automation, 'unseen', 'completed')
    const { runtime, service: host } = fakeRuntime(['tab-seen'])
    const service = createRuntimeAutomationService({
      store,
      runtime: host,
      allowRemoteHostScheduling: false
    })

    await expect(service.runTerminalRetention?.drain()).resolves.toBe(1)

    expect(runtime.closeTerminal.mock.calls).toEqual([[`handle:${PANE('unseen')}`]])
    expect(readRun(store, focused)?.terminalPtyId).toBe('pty-seen')
    expect(readRun(store, untouched)?.terminalPtyId).toBeNull()
  })

  it('closes an untouched run terminal beyond the newest three on the scheduler tick, until stopped', async () => {
    const store = await createStore()
    const automation = createAutomation(store)
    const runs = ['a', 'b', 'c', 'd'].map((name) => {
      vi.advanceTimersByTime(1000)
      return retainRun(store, automation, name, 'completed')
    })
    const { runtime, service: host } = fakeRuntime()
    const service = createRuntimeAutomationService({
      store,
      runtime: host,
      allowRemoteHostScheduling: false
    })

    service.start()
    await vi.advanceTimersByTimeAsync(12 * 60_000)

    expect(runtime.closeTerminal.mock.calls).toEqual([[`handle:${PANE('a')}`]])
    service.stop()
    retainRun(store, automation, 'e', 'completed')
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(readRun(store, runs[1])?.terminalPtyId).toBe('pty-b')
  })
})
