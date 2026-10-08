import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, makeRepo, testState } from '../persistence-test-harness'
import type { AutomationService } from '../automations/service'
import { orcadAutomationsKeepHostBusy, startOrcadAutomations } from './orcad-automations'

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))

function headlessRuntime() {
  let bound: AutomationService | null = null
  const runtime = {
    setAutomationService: vi.fn((service: AutomationService) => {
      bound = service
    }),
    notifyAutomationsChanged: vi.fn(),
    createManagedWorktree: vi.fn(async () => ({
      worktree: { id: 'r1::/repo/wt', displayName: 'wt' },
      startupTerminal: { handle: 'term-1', tabId: 'tab-1', paneKey: 'tab-1:1', ptyId: 'pty-1' }
    })),
    waitForTerminal: vi.fn(async () => ({ satisfied: true })),
    readTerminal: vi.fn(async () => ({ tail: ['done'] })),
    getTerminalHandleForPaneKey: vi.fn(() => null),
    getAgentStatusRowsForPane: vi.fn(() => [])
  }
  return { runtime, service: () => bound }
}

describe('orcad automations', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orcad-automations-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('binds a headless service, so a run dispatches on orcad without a renderer', async () => {
    const store = createStore()
    store.addRepo(makeRepo())
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.parse('2026-05-13T00:00:00Z')
    })
    const { runtime, service } = headlessRuntime()
    const cleanups: (() => void)[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the headless dispatcher reaches only the runtime methods stubbed above.
    startOrcadAutomations(runtime as never, store, (cleanup) => cleanups.push(cleanup))
    try {
      expect(runtime.setAutomationService).toHaveBeenCalledOnce()
      const run = await service()!.runNow(automation.id)
      expect(runtime.createManagedWorktree).toHaveBeenCalledOnce()
      expect(run.status).toBe('dispatched')
      expect(orcadAutomationsKeepHostBusy(store)).toBe(true)
    } finally {
      cleanups.forEach((cleanup) => cleanup())
    }
  })

  it('lets a host with no enabled schedule and no unsettled run idle out', () => {
    const store = { listAutomations: () => [], listAutomationRuns: () => [] }
    expect(orcadAutomationsKeepHostBusy(store)).toBe(false)
  })

  // Booting orcad here would need its whole runtime; the wiring is pinned by the entry point's text.
  it('orcad starts the service with its runtime and feeds it to managed idle exit', () => {
    const entry = readFileSync(join(import.meta.dirname, 'orcad-entry.ts'), 'utf8')
    expect(entry).toContain('startOrcadAutomations(runtime, profileStore, registerCleanup)')
    expect(entry).toContain('automationsBusy: () => orcadAutomationsKeepHostBusy(profileStore)')
  })
})
