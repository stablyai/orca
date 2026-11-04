import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { buildAutomationOnceSchedule } from '../../shared/automation-once-schedule'
import { AutomationService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const scheduledFor = Date.parse('2028-02-29T15:42:00.000Z')
const services: AutomationService[] = []

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-automation-once-'))
  vi.useFakeTimers()
  vi.setSystemTime(scheduledFor - 60_000)
})

afterEach(async () => {
  for (const service of services.splice(0)) {
    service.stop()
  }
  await closeTestStores()
  vi.useRealTimers()
  rmSync(testState.dir, { recursive: true, force: true })
})

async function createOnce(grace = 720) {
  const store = await createStore()
  store.addRepo({ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 })
  const automation = store.createAutomation({
    name: 'One-time check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'r1',
    workspaceMode: 'existing',
    workspaceId: 'wt1',
    timezone: 'UTC',
    rrule: buildAutomationOnceSchedule(scheduledFor),
    dtstart: Date.now(),
    missedRunGraceMinutes: grace
  })
  return { store, automation }
}

function startService(store: Awaited<ReturnType<typeof createStore>>) {
  const send = vi.fn()
  const service = new AutomationService(store, { tickMs: 1000 })
  services.push(service)
  service.setWebContents({ isDestroyed: () => false, send })
  service.start()
  service.setRendererReady()
  return { service, send }
}

describe('one-time automation execution', () => {
  it('waits for the chosen minute, dispatches once, and remains disabled after a store reload', async () => {
    const { store, automation } = await createOnce()
    const { service, send } = startService(store)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(store.listAutomations()[0].enabled).toBe(false))
    expect(send).toHaveBeenCalledOnce()
    expect(store.listAutomationRuns(automation.id)).toMatchObject([
      { scheduledFor, status: 'dispatching' }
    ])
    service.stop()
    await closeTestStores()

    vi.setSystemTime(scheduledFor + 366 * 86400_000)
    const reloaded = await createStore()
    expect(reloaded.listAutomations()[0].enabled).toBe(false)
    const restarted = startService(reloaded)
    await vi.advanceTimersByTimeAsync(2000)
    expect(restarted.send).not.toHaveBeenCalled()
    expect(reloaded.listAutomationRuns(automation.id)).toHaveLength(1)
  })

  it('catches up once after restarting within the missed-run grace', async () => {
    const { store, automation } = await createOnce(10)
    await store.flushPendingOrThrowAsync()
    await closeTestStores()
    vi.setSystemTime(scheduledFor + 5 * 60_000)
    const reloaded = await createStore()
    const { send } = startService(reloaded)
    await vi.waitFor(() => expect(reloaded.listAutomations()[0].enabled).toBe(false))
    expect(send).toHaveBeenCalledOnce()
    expect(reloaded.listAutomationRuns(automation.id)[0].scheduledFor).toBe(scheduledFor)
  })

  it('records an expired occurrence and stops scheduling it', async () => {
    const { store, automation } = await createOnce(1)
    vi.setSystemTime(scheduledFor + 10 * 60_000)
    const { send } = startService(store)
    await vi.waitFor(() => expect(store.listAutomations()[0].enabled).toBe(false))
    expect(send).not.toHaveBeenCalled()
    expect(store.listAutomationRuns(automation.id)).toMatchObject([
      { scheduledFor, status: 'skipped_missed' }
    ])
    expect(() => store.updateAutomation(automation.id, { enabled: true })).toThrow(/future/)
    const renamed = store.updateAutomation(automation.id, { name: 'Finished check' })
    expect(renamed.name).toBe('Finished check')
  })
})
