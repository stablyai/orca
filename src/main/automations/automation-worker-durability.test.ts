import { describe, expect, it, vi } from 'vitest'
import { AutomationService } from './service'
import type { Store } from '../persistence'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from '../persistence/loading-store/profile-state-maintenance-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/ssh-config-parser', () => ({
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
    dtstart: Date.now() - 60_000
  })
  await fixture.store.flushPendingOrThrowAsync()
  return { ...fixture, automation }
}

const launch = { workspaceId: 'repo-local::/fixture/local', terminalSessionId: 'run-tab' }

function blockAcknowledgement(store: Store, index: number) {
  const gate = maintenanceBarrier()
  const blocked = maintenanceBarrier()
  const flush = store.flushPendingOrThrowAsync.bind(store)
  let calls = 0
  vi.spyOn(store, 'flushPendingOrThrowAsync').mockImplementation(async (options) => {
    calls += 1
    if (calls === index) {
      blocked.resolve()
      await gate.promise
    }
    await flush(options)
  })
  return { blocked: blocked.promise, release: gate.resolve }
}

describe('automation background writer durability', () => {
  it('claims a shared occurrence once when callers await the same pending row', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const { store, automation } = await fixture()
    const dispatcher = vi.fn(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const runs = await Promise.all([service.runNow(automation.id), service.runNow(automation.id)])
      expect(new Set(runs.map((run) => run.id)).size).toBe(1)
      expect(dispatcher).toHaveBeenCalledOnce()
    } finally {
      service.stop()
    }
  })

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
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const run = service.runNow(automation.id)
      await Promise.resolve()
      expect(dispatcher).not.toHaveBeenCalled()
      gate.resolve()
      await expect(run).resolves.toMatchObject({ status: 'dispatched' })
      expect(dispatcher).toHaveBeenCalledOnce()
    } finally {
      service.stop()
    }
  })

  it('never dispatches when the writer refuses the durable acknowledgement', async () => {
    const { store, automation } = await fixture()
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk full'))
    const dispatcher = vi.fn(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      await expect(service.runNow(automation.id)).rejects.toThrow('disk full')
      expect(dispatcher).not.toHaveBeenCalled()
    } finally {
      service.stop()
    }
  })

  it.each([
    ['dispatching', 1],
    ['dispatched', 1],
    ['completed', 1],
    ['dispatching', 120_001],
    ['dispatched', 120_001],
    ['completed', 120_001]
  ] as const)(
    'preserves a durable %s occurrence after %s ms when next-run advancement was interrupted',
    async (status, lateness) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
      const { store, automation, readState } = await fixture()
      store.updateAutomation(automation.id, { missedRunGraceMinutes: 0 })
      const dueAt = automation.nextRunAt
      const run = store.createAutomationRun(automation, dueAt)
      store.updateAutomationRun({ runId: run.id, status })
      await store.flushPendingOrThrowAsync()
      clock.mockReturnValue(dueAt + lateness)
      const dispatcher = vi.fn(async () => launch)
      const service = new AutomationService(store, { headlessDispatcher: dispatcher })
      try {
        service.start()
        await vi.waitFor(() => {
          const stored = readState().automations.find(
            (entry: { id: string }) => entry.id === automation.id
          )
          expect(stored.nextRunAt).toBeGreaterThan(dueAt + lateness)
        })
        expect(dispatcher).not.toHaveBeenCalled()
        expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
        expect(store.listAutomationRuns(automation.id)[0].status).toBe(status)
      } finally {
        service.stop()
      }
    }
  )

  it.each([1, 2])('cancels a pending dispatch stopped during acknowledgement %s', async (index) => {
    const { store, automation } = await fixture()
    const acknowledgement = blockAcknowledgement(store, index)
    const dispatcher = vi.fn(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    const pending = service.runNow(automation.id)
    const rejected = expect(pending).rejects.toThrow('stopped before')
    await acknowledgement.blocked
    service.stop()
    acknowledgement.release()
    await rejected
    expect(dispatcher).not.toHaveBeenCalled()
  })

  it('does not resurrect or dispatch an automation deleted during its intent acknowledgement', async () => {
    const { store, automation, readState } = await fixture()
    const acknowledgement = blockAcknowledgement(store, 2)
    const dispatcher = vi.fn(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const pending = service.runNow(automation.id)
      const rejected = expect(pending).rejects.toThrow('removed before')
      await acknowledgement.blocked
      store.deleteAutomation(automation.id)
      acknowledgement.release()
      await rejected
      expect(dispatcher).not.toHaveBeenCalled()
      expect(
        readState().automationRuns.some(
          (run: { automationId: string }) => run.automationId === automation.id
        )
      ).toBe(false)
    } finally {
      service.stop()
    }
  })

  it.each([1, 2])('refuses changed instructions during acknowledgement %s', async (index) => {
    const { store, automation } = await fixture()
    const acknowledgement = blockAcknowledgement(store, index)
    const dispatcher = vi.fn(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const pending = service.runNow(automation.id)
      await acknowledgement.blocked
      store.updateAutomation(automation.id, { prompt: 'Different instructions' })
      acknowledgement.release()
      await expect(pending).resolves.toMatchObject({
        status: 'skipped_unavailable',
        error: expect.stringContaining('changed before')
      })
      expect(dispatcher).not.toHaveBeenCalled()
    } finally {
      service.stop()
    }
  })

  it.each([1, 2])('refuses a moved execution host during acknowledgement %s', async (index) => {
    const { store, automation } = await fixture()
    const acknowledgement = blockAcknowledgement(store, index)
    const dispatcher = vi.fn(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const pending = service.runNow(automation.id)
      await acknowledgement.blocked
      store.updateRepo('repo-local', { executionHostId: 'runtime:other-host' })
      acknowledgement.release()
      await expect(pending).resolves.toMatchObject({ status: 'skipped_unavailable' })
      expect(dispatcher).not.toHaveBeenCalled()
    } finally {
      service.stop()
    }
  })

  it.each(['disconnect', 'replacement'] as const)(
    'refuses an unready renderer after %s during acknowledgement',
    async (change) => {
      const { store, automation } = await fixture()
      const acknowledgement = blockAcknowledgement(store, 2)
      const renderer = { isDestroyed: () => false, send: vi.fn() }
      const replacement = { isDestroyed: () => false, send: vi.fn() }
      const service = new AutomationService(store)
      service.setWebContents(renderer)
      service.setRendererReady()
      try {
        const pending = service.runNow(automation.id)
        await acknowledgement.blocked
        service.setWebContents(change === 'disconnect' ? null : replacement)
        acknowledgement.release()
        await expect(pending).resolves.toMatchObject({ status: 'skipped_unavailable' })
        expect(renderer.send).not.toHaveBeenCalled()
        expect(replacement.send).not.toHaveBeenCalled()
      } finally {
        service.stop()
      }
    }
  )
})
