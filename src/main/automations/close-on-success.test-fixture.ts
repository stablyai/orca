import { afterEach, beforeEach, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  makeRepo,
  readDataFile,
  testState
} from '../persistence-test-harness'
import { createRuntimeAutomationService } from './runtime-automation-service'
import { collectAutomationRunUsage } from './run-usage-collection'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AutomationRun } from '../../shared/automations-types'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

export const BASE = {
  name: 'Daily check',
  prompt: 'Check',
  agentId: 'goose' as const,
  projectId: 'r1',
  workspaceMode: 'existing' as const,
  workspaceId: 'wt1',
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 1,
  enabled: false
}
export const snapshot = {
  format: 'plain_text' as const,
  content: 'Done',
  capturedAt: 1,
  truncated: false
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-close-on-success-'))
  vi.useFakeTimers()
})
afterEach(async () => {
  await closeTestStores()
  vi.useRealTimers()
  rmSync(testState.dir, { recursive: true, force: true })
})

export async function setup(headless = true, usageGate: Promise<void> = Promise.resolve()) {
  const store = await createStore()
  store.addRepo(makeRepo())
  const panes = new Map([
    ['run:11111111-1111-4111-8111-111111111111', 'pty-run'],
    ['run:22222222-2222-4222-8222-222222222222', 'pty-user']
  ])
  const runtime = {
    setAutomationService: vi.fn<() => void>(),
    notifyAutomationsChanged: vi.fn<() => void>(),
    getTerminalHandleForPaneKey: (key: string) => (panes.has(key) ? key : null),
    getTerminalPtyIdForHandle: (handle: string) => panes.get(handle) ?? null,
    getAgentStatusRowsForPane: vi.fn(
      (): Pick<
        AgentStatusIpcPayload,
        | 'state'
        | 'stateStartedAt'
        | 'turnEndedAt'
        | 'turnEndDisposition'
        | 'sessionBoundary'
        | 'providerSessionOnly'
        | 'interrupted'
        | 'restoredUnconfirmed'
      >[] => [
        {
          state: 'done',
          stateStartedAt: Date.now(),
          turnEndedAt: Date.now(),
          turnEndDisposition: 'identified'
        }
      ]
    ),
    waitForTerminal: vi.fn(async () => ({ satisfied: false })),
    readTerminal: vi.fn(async () => ({ tail: [snapshot.content] })),
    readTerminalClientUse: vi.fn((_ptyId: string): 'unused' | 'used' | 'unknown' => 'unused'),
    confirmTerminalShellAlone: vi.fn(async () => false),
    sleepTerminalsForWorktree: vi.fn<() => void>(),
    closeTerminal: vi.fn(async (handle: string) => {
      // This reads the actual SQLite-backed state, before the pane is closed.
      expect(readDataFile()).toMatchObject({
        automationRuns: [
          expect.objectContaining({
            status: 'completed',
            outputSnapshot: expect.objectContaining({
              content: snapshot.content,
              format: snapshot.format
            }),
            usage: expect.objectContaining({ status: 'unavailable' })
          })
        ]
      })
      panes.delete(handle)
    })
  }
  let usageStarted = () => {}
  const usageRequested = new Promise<void>((resolve) => {
    usageStarted = resolve
  })
  const service = createRuntimeAutomationService({
    store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: automation usage collection needs only this provider port.
    claudeUsage: {
      getAutomationRunUsage: async () => {
        usageStarted()
        await usageGate
        return collectAutomationRunUsage({
          automation: undefined,
          run: store.listAutomationRuns()[0],
          claudeUsage: null,
          codexUsage: null
        })
      }
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real retention adapter uses the runtime ports implemented above.
    runtime: runtime as never,
    headless
  })
  const settle = async (automationId: string) => {
    await service.runInAutomationLane(automationId, async () => {})
    await Promise.resolve()
    await Promise.resolve()
  }
  const launch = (
    closeOnSuccess = true,
    trigger: AutomationRun['trigger'] = 'manual',
    agentId: 'goose' | 'claude' = 'goose'
  ) => {
    const automation = store.createAutomation({ ...BASE, closeOnSuccess, agentId })
    const run = store.createAutomationRun(automation, Date.now(), trigger)
    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      terminalSessionId: 'run',
      terminalPaneKey: 'run:11111111-1111-4111-8111-111111111111',
      terminalPtyId: 'pty-run'
    })
    return { automation, run }
  }
  return { store, panes, runtime, service, settle, launch, usageRequested }
}
