import { describe, expect, it, vi } from 'vitest'
import { AutomationService } from './automation-service'
import { runNowSettled } from './testing/automation-run-now-settled.test-fixture'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../persistence/loading-store/profile-writing/profile-state-maintenance-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

async function fixture() {
  const fixture = await createWorkerMaintenanceFixture()
  for (const automation of fixture.store.listAutomations()) {
    fixture.store.updateAutomation(automation.id, { enabled: false })
  }
  const automation = fixture.store.createAutomation({
    name: 'Durable run',
    prompt: 'Check the project',
    agentId: 'claude',
    projectId: 'repo-local',
    workspaceMode: 'existing',
    workspaceId: 'repo-local::/fixture/local',
    timezone: 'UTC',
    rrule: 'FREQ=HOURLY;BYMINUTE=0',
    dtstart: 1_800_000_000_000
  })
  await fixture.store.flushPendingOrThrowAsync()
  return { ...fixture, automation }
}

const launch = { workspaceId: 'repo-local::/fixture/local', terminalSessionId: 'run-tab' }

describe('automation background writer durability', () => {
  it('persists dispatch intent before starting external work', async () => {
    const { store, automation, readState } = await fixture()
    const gate = maintenanceBarrier()
    const flush = store.flushPendingOrThrowAsync.bind(store)
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockImplementationOnce(async (options) => {
      await gate.promise
      await flush(options)
    })
    const dispatcher = vi.fn(async () => {
      expect(readState().automationRuns).toContainEqual(
        expect.objectContaining({ automationId: automation.id, status: 'dispatching' })
      )
      return launch
    })
    const service = new AutomationService(store, {
      terminalLauncher: { launch: dispatcher, available: () => true }
    })
    try {
      const run = runNowSettled(service, store, automation.id)
      await Promise.resolve()
      expect(dispatcher).not.toHaveBeenCalled()
      gate.resolve()
      await expect(run).resolves.toMatchObject({ status: 'dispatched' })
      expect(dispatcher).toHaveBeenCalledOnce()
    } finally {
      service.stop()
    }
  })
})
