import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AutomationService } from './automation-service'
import { AutomationRunLaunchError } from './launch/automation-launch'

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

  it('records when the agent terminal opened, and keeps it after retention clears the pane', async () => {
    const { store, service, run, row, settle } = await heldLaunch('delivery')
    await vi.waitFor(() => expect(row()?.terminalPaneKey).toBe(OPENED.terminalPaneKey))
    await settle("Aider started, but Orca could not send this run's prompt.")
    const launchedAt = row()?.launchedAt
    expect(launchedAt).toEqual(expect.any(Number))
    expect(row()?.dispatchedAt).toBeNull()

    // Dead-PTY retention forgets the terminal but must not forget that the agent launched.
    store.updateAutomationRun({
      runId: run.id,
      status: 'dispatch_failed',
      error: row()?.error ?? null,
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    })
    expect(row()).toMatchObject({ terminalPaneKey: null, launchedAt })
    service.stop()
  })
})

async function failingLaunch(error: Error) {
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
  const service = new AutomationService(store, {
    tickMs: 60_000,
    allowRemoteHostScheduling: true,
    terminalLauncher: {
      launch: async () => {
        throw error
      },
      available: () => true
    }
  })
  const run = await service.runNow(automation.id)
  await service.runInAutomationLane(automation.id, async () => undefined)
  await vi.waitFor(() =>
    expect(
      store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)?.status
    ).toBe('dispatch_failed')
  )
  const row = store.listAutomationRuns(automation.id).find((entry) => entry.id === run.id)
  service.stop()
  return row
}

describe('launch evidence when the launcher throws', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-launch-evidence-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('records a partial start that opened the agent terminal', async () => {
    const row = await failingLaunch(new AutomationRunLaunchError('Prompt paste failed.', OPENED))
    expect(row?.launchedAt).toEqual(expect.any(Number))
  })

  it('records nothing for a launch that failed before opening anything', async () => {
    const row = await failingLaunch(new Error('No window to open the terminal in.'))
    expect(row?.launchedAt).toBeUndefined()
  })
})
