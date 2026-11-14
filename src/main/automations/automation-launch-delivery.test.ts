import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AutomationService } from './automation-service'
import { AutomationRunLaunchError } from './launch/automation-launch'
import type { AutomationRun } from '../../shared/automations/history/automation-run'

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

  it('records launch evidence once the agent terminal exists even when delivery fails', async () => {
    const { service, row, settle } = await heldLaunch('delivery')
    await vi.waitFor(() => expect(row()?.terminalPaneKey).toBe(OPENED.terminalPaneKey))
    await settle("Aider started, but Orca could not send this run's prompt.")
    const launchedAt = row()?.launchedAt
    expect(launchedAt).toEqual(expect.any(Number))
    expect(row()?.dispatchedAt).toBeNull()

    service.stop()
  })
})

/** Launches one automation per error, each with a launcher that throws that error. */
async function failingLaunches(errors: Error[]) {
  const store = await createStore()
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'repo', badgeColor: '#fff', addedAt: 1 })
  const pending = [...errors]
  const service = new AutomationService(store, {
    tickMs: 60_000,
    allowRemoteHostScheduling: true,
    terminalLauncher: {
      launch: async () => {
        throw pending.shift() ?? new Error('Unexpected launch.')
      },
      available: () => true
    }
  })
  const rows: (AutomationRun | undefined)[] = []
  for (const [index] of errors.entries()) {
    const automation = store.createAutomation({
      name: `Nightly ${index}`,
      prompt: 'Fix the flaky test',
      agentId: 'aider',
      projectId: 'r1',
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.UTC(2026, 4, 12)
    })
    const run = await service.runNow(automation.id)
    await service.runInAutomationLane(automation.id, async () => undefined)
    const row = () => store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
    await vi.waitFor(() => expect(row()?.status).toBe('dispatch_failed'))
    rows.push(row())
  }
  service.stop()
  return rows
}

describe('launch evidence when the launcher throws', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-launch-evidence-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('records a partial start that opened the agent terminal, but not a launch that opened nothing', async () => {
    const [partial, preOpen] = await failingLaunches([
      new AutomationRunLaunchError('Prompt paste failed.', OPENED),
      new Error('No window to open the terminal in.')
    ])
    expect(partial?.launchedAt).toEqual(expect.any(Number))
    // Safety: a failure before any terminal or session opened leaves no launch evidence.
    expect(preOpen?.launchedAt).toBeUndefined()
  })
})
