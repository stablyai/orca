import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AutomationService } from './service'

vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))

const OPENED = {
  workspaceId: 'r1::/repo/wt',
  terminalSessionId: 'tab-1',
  terminalPaneKey: 'tab-1:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  terminalPtyId: 'pty-1'
}

async function heldLaunch(hold: 'launch' | 'delivery') {
  const store = await createStore()
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'repo', badgeColor: '#fff', addedAt: 1 })
  const automation = store.createAutomation({
    name: 'Nightly',
    prompt: 'Fix the flaky test',
    agentId: 'aider',
    projectId: 'r1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.UTC(2026, 4, 12)
  })
  let release: (error: string | null) => void = () => {}
  const released = new Promise<string | null>((resolve) => (release = resolve))
  let reach: () => void = () => {}
  const reached = new Promise<void>((resolve) => (reach = resolve))
  const service = new AutomationService(store, {
    tickMs: 60_000,
    allowRemoteHostScheduling: true,
    terminalLauncher: {
      launch: async () => {
        reach()
        if (hold === 'launch') {
          await released
          return OPENED
        }
        return { ...OPENED, delivery: released.then((error) => ({ error })) }
      },
      available: () => true
    }
  })
  const run = await service.runNow(automation.id)
  const row = () => store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
  const settle = async (error: string | null) => {
    release(error)
    await service.runInAutomationLane(automation.id, async () => undefined)
  }
  return { store, service, run, row, reached, settle }
}

describe('headless dispatch prompt delivery', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-delivery-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('links the terminal while delivery is held, then fails an undelivered run keeping it', async () => {
    const { service, row, settle } = await heldLaunch('delivery')

    await vi.waitFor(() =>
      expect(row()).toMatchObject({
        status: 'dispatching',
        terminalPaneKey: 'tab-1:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
        terminalPtyId: 'pty-1'
      })
    )
    await settle("Aider started, but Orca could not send this run's prompt.")

    expect(row()).toMatchObject({
      status: 'dispatch_failed',
      terminalPaneKey: 'tab-1:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
      terminalPtyId: 'pty-1',
      error: "Aider started, but Orca could not send this run's prompt."
    })
    service.stop()
  })

  it.each(['launch', 'delivery'] as const)(
    'keeps a run settled while its %s was held when that launch later succeeds',
    async (hold) => {
      const { store, service, run, row, reached, settle } = await heldLaunch(hold)
      await reached
      if (hold === 'delivery') {
        await vi.waitFor(() => expect(row()?.terminalPaneKey).toBe(OPENED.terminalPaneKey))
      }
      store.updateAutomationRun({ runId: run.id, status: 'dispatch_failed', error: 'Stranded.' })

      await settle(null)

      expect(row()).toMatchObject({ status: 'dispatch_failed', error: 'Stranded.' })
      service.stop()
    }
  )
})
