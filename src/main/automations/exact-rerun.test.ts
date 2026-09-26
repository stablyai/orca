import { describe, expect, it, vi } from 'vitest'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import { AutomationService } from './service'
import { createWorkerMaintenanceFixture } from '../persistence/loading-store/profile-state-maintenance-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const MONDAY = Date.parse('2026-09-23T03:00:00Z') // Tuesday 20:00 Pacific reports Monday.
const NOW = Date.parse('2026-09-26T18:00:00Z')
const launch = { workspaceId: 'repo-local::/fixture/local', terminalSessionId: 'retry-tab' }

async function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const fixture = await createWorkerMaintenanceFixture()
  for (const automation of fixture.store.listAutomations()) {
    fixture.store.updateAutomation(automation.id, { enabled: false })
  }
  const automation = fixture.store.createAutomation({
    name: 'Daily costs',
    prompt: 'Report yesterday. New manual runs should use the oldest pending period.',
    agentId: 'codex',
    projectId: 'repo-local',
    workspaceMode: 'existing',
    workspaceId: launch.workspaceId,
    timezone: 'America/Los_Angeles',
    rrule: 'FREQ=DAILY;BYHOUR=20;BYMINUTE=0',
    dtstart: MONDAY,
    enabled: false
  })
  const source = fixture.store.createAutomationRun(automation, MONDAY)
  fixture.store.updateAutomationRun({ runId: source.id, status: 'dispatch_failed' })
  const newer = fixture.store.createAutomationRun(automation, MONDAY + 86_400_000)
  fixture.store.updateAutomationRun({ runId: newer.id, status: 'dispatch_failed' })
  await fixture.store.flushPendingOrThrowAsync()
  return { ...fixture, automation, source, newer }
}

describe('exact historical automation reruns', () => {
  it('retries the selected older occurrence, durably, without changing the schedule or source', async () => {
    const { store, automation, source, readState } = await fixture()
    const original = store.listAutomationRuns(automation.id)
    const dispatcher = vi.fn<HeadlessAutomationDispatcher>(async (request) => {
      expect(readState().automationRuns).toContainEqual(
        expect.objectContaining({
          id: request.run.id,
          scheduledFor: MONDAY,
          rerun: { sourceRunId: source.id, originalRunId: source.id },
          status: 'dispatching'
        })
      )
      return launch
    })
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const retry = await service.runNow(automation.id, source.id)
      expect(retry).toMatchObject({ scheduledFor: MONDAY, createdAt: NOW, trigger: 'manual' })
      expect(retry.id).not.toBe(source.id)
      expect(store.listAutomationRuns(automation.id)).toEqual(expect.arrayContaining(original))
      expect(store.listAutomations().find((entry) => entry.id === automation.id)?.nextRunAt).toBe(
        automation.nextRunAt
      )
      const prompt = dispatcher.mock.calls[0][0].automation.prompt
      expect(prompt).toContain(`Original run ID: ${source.id}`)
      expect(prompt).toContain('2026-09-23T03:00:00.000Z')
      expect(prompt).toContain('takes precedence over defaults')
      expect(prompt).toContain(automation.prompt)
    } finally {
      service.stop()
    }
  })

  it('keeps the original binding when retrying a retry, even after recreating the service', async () => {
    const { store, automation, source, readState } = await fixture()
    const firstService = new AutomationService(store, { headlessDispatcher: async () => launch })
    const first = await firstService.runNow(automation.id, source.id)
    await firstService.markDispatchResult({ runId: first.id, status: 'dispatch_failed' })
    firstService.stop()
    const service = new AutomationService(store, { headlessDispatcher: async () => launch })
    try {
      const retry = await service.runNow(automation.id, first.id)
      expect(retry).toMatchObject({
        scheduledFor: MONDAY,
        rerun: { sourceRunId: first.id, originalRunId: source.id }
      })
      expect(readState().automationRuns).toContainEqual(
        expect.objectContaining({
          id: retry.id,
          scheduledFor: MONDAY,
          rerun: retry.rerun
        })
      )
      const fromOriginal = await service.runNow(automation.id, source.id)
      expect(fromOriginal.id).toBe(retry.id)
      expect(store.listAutomationRuns(automation.id)).toHaveLength(4)
    } finally {
      service.stop()
    }
  })

  it('retains the original timezone after editing the schedule timezone', async () => {
    const { store, automation, source, readState } = await fixture()
    store.updateAutomation(automation.id, { timezone: 'Asia/Tokyo' })
    const dispatcher = vi.fn<HeadlessAutomationDispatcher>(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const retry = await service.runNow(automation.id, source.id)
      expect(retry.scheduledTimezone).toBe('America/Los_Angeles')
      expect(readState().automationRuns).toContainEqual(
        expect.objectContaining({
          id: retry.id,
          scheduledTimezone: 'America/Los_Angeles'
        })
      )
      expect(dispatcher.mock.calls[0][0].automation.prompt).toContain(
        'Original schedule timezone: America/Los_Angeles'
      )
      expect(dispatcher.mock.calls[0][0].automation.prompt).not.toContain('Asia/Tokyo')
    } finally {
      service.stop()
    }
  })

  it('does not invent the timezone for a legacy historical run', async () => {
    const { store, automation, source } = await fixture()
    const listRuns = store.listAutomationRuns.bind(store)
    vi.spyOn(store, 'listAutomationRuns').mockImplementation((id) =>
      listRuns(id).map((run) =>
        run.id === source.id ? { ...run, scheduledTimezone: undefined } : run
      )
    )
    const dispatcher = vi.fn<HeadlessAutomationDispatcher>(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const retry = await service.runNow(automation.id, source.id)
      expect(retry.scheduledTimezone).toBeNull()
      expect(dispatcher.mock.calls[0][0].automation.prompt).toContain(
        'The original schedule timezone was not recorded.'
      )
      expect(dispatcher.mock.calls[0][0].automation.prompt).toContain('request that period')
    } finally {
      service.stop()
    }
  })

  it('coalesces concurrent retries of the same selected run into one launch', async () => {
    const { store, automation, source } = await fixture()
    const dispatcher = vi.fn(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const attempts = await Promise.all([
        service.runNow(automation.id, source.id),
        service.runNow(automation.id, source.id)
      ])
      expect(attempts[0].id).toBe(attempts[1].id)
      expect(dispatcher).toHaveBeenCalledOnce()
    } finally {
      service.stop()
    }
  })

  it('refuses missing, foreign, and still-running sources without starting today instead', async () => {
    const { store, automation, source } = await fixture()
    const dispatcher = vi.fn(async () => launch)
    const service = new AutomationService(store, { headlessDispatcher: dispatcher })
    try {
      const before = store.listAutomationRuns()
      await expect(service.runNow(automation.id, 'missing')).rejects.toThrow('not found')
      const other = store.listAutomations().find((entry) => entry.id !== automation.id)
      expect(other).toBeDefined()
      await expect(service.runNow(other!.id, source.id)).rejects.toThrow('not found')
      store.updateAutomationRun({ runId: source.id, status: 'dispatched' })
      await expect(service.runNow(automation.id, source.id)).rejects.toThrow('still running')
      expect(store.listAutomationRuns()).toHaveLength(before.length)
      expect(dispatcher).not.toHaveBeenCalled()
    } finally {
      service.stop()
    }
  })

  it('sends the same historical binding to desktop agents and leaves Run now unchanged', async () => {
    const { store, automation, source } = await fixture()
    const service = new AutomationService(store)
    const send = vi.fn()
    service.setWebContents({ isDestroyed: () => false, send })
    service.setRendererReady()
    try {
      const retry = await service.runNow(automation.id, source.id)
      expect(send).toHaveBeenCalledWith(
        'automations:dispatchRequested',
        expect.objectContaining({
          automation: expect.objectContaining({
            prompt: expect.stringContaining(`Original run ID: ${source.id}`)
          }),
          run: expect.objectContaining({ id: retry.id, scheduledFor: MONDAY })
        })
      )
      const fresh = await service.runNow(automation.id)
      expect(fresh.scheduledFor).toBe(NOW)
      expect(fresh.rerun).toBeUndefined()
      expect(send).toHaveBeenLastCalledWith(
        'automations:dispatchRequested',
        expect.objectContaining({
          automation: expect.objectContaining({ prompt: automation.prompt })
        })
      )
    } finally {
      service.stop()
    }
  })
})
