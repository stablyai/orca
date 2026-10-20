import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { NO_DISPATCH_HOST } from './dispatch-refusal'
import { AutomationService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const dueAt = new Date(2026, 4, 13, 9).getTime()
const nextDay = new Date(2026, 4, 14, 9).getTime()
const services: AutomationService[] = []

async function setup() {
  const store = createStore()
  store.addRepo({
    id: 'repo-ready',
    path: '/repo',
    displayName: 'Readiness',
    badgeColor: '#fff',
    addedAt: 1
  })
  const automation = store.createAutomation({
    name: 'Startup due run',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'repo-ready',
    workspaceMode: 'existing',
    workspaceId: 'wt-ready',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: new Date(2026, 4, 12).getTime(),
    missedRunGraceMinutes: 0
  })
  await store.flushPendingOrThrowAsync()
  const send = vi.fn()
  const service = new AutomationService(store)
  services.push(service)
  service.setWebContents({ isDestroyed: () => false, send })
  return { store, automation, send, service }
}

describe('AutomationService renderer startup readiness', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-ready-'))
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(dueAt - 30_000)
  })

  afterEach(async () => {
    for (const service of services.splice(0)) {
      service.stop()
    }
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps a due occurrence and its persisted nextRunAt until renderer readiness, then dispatches once', async () => {
    const { store, automation, send, service } = await setup()
    const advance = vi.spyOn(store, 'advanceAutomationNextRun')
    service.start()
    await vi.advanceTimersByTimeAsync(60_000)
    // Let an erroneous evaluation finish so RED reports its durable refusal, not a pending row.
    if (store.listAutomationRuns(automation.id).length) {
      await vi.waitFor(() => expect(advance).toHaveBeenCalledOnce())
    }
    expect.soft(store.listAutomationRuns(automation.id)).toEqual([])
    expect.soft(store.listAutomations()[0]?.nextRunAt).toBe(dueAt)
    expect.soft(advance).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()

    service.setRendererReady()
    service.setRendererReady()
    await vi.waitFor(() => expect(store.listAutomations()[0]?.nextRunAt).toBe(nextDay))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      'automations:dispatchRequested',
      expect.objectContaining({
        automation: expect.objectContaining({ id: automation.id }),
        run: expect.objectContaining({
          scheduledFor: dueAt,
          trigger: 'scheduled',
          status: 'dispatching'
        })
      })
    )
    expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
    expect(advance).toHaveBeenCalledOnce()
    await store.flushPendingOrThrowAsync()
    expect(createStore().listAutomations()[0]?.nextRunAt).toBe(nextDay)
  })

  it('applies the existing missed-run grace policy when readiness arrives too late', async () => {
    const { store, automation, send, service } = await setup()
    service.start()
    await vi.advanceTimersByTimeAsync(180_000)
    expect.soft(store.listAutomationRuns(automation.id)).toEqual([])
    expect.soft(store.listAutomations()[0]?.nextRunAt).toBe(dueAt)
    service.setRendererReady()
    await vi.waitFor(() => expect(store.listAutomations()[0]?.nextRunAt).toBe(nextDay))
    expect(store.listAutomationRuns(automation.id)).toEqual([
      expect.objectContaining({ scheduledFor: dueAt, status: 'skipped_missed' })
    ])
    expect(send).not.toHaveBeenCalled()
  })

  it('does not duplicate an in-flight occurrence when a timer tick and readiness overlap', async () => {
    const { store, automation, send, service } = await setup()
    let releaseWrite = (): void => {}
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const flush = store.flushPendingOrThrowAsync.bind(store)
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockImplementationOnce(async (options) => {
      await writeGate
      await flush(options)
    })
    service.start()
    vi.setSystemTime(dueAt + 30_000)
    try {
      service.setRendererReady()
      expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(60_000)
      service.setRendererReady()
      expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
      expect(store.listAutomations()[0]?.nextRunAt).toBe(dueAt)
      expect(send).not.toHaveBeenCalled()
      releaseWrite()
      await vi.waitFor(() => expect(store.listAutomations()[0]?.nextRunAt).toBe(nextDay))
      expect(send).toHaveBeenCalledOnce()
      expect(store.listAutomationRuns(automation.id)).toHaveLength(1)
    } finally {
      releaseWrite()
    }
  })

  it('preserves explicit manual-run NO_DISPATCH_HOST before renderer readiness', async () => {
    const { store, automation, send, service } = await setup()
    const run = await service.runNow(automation.id)
    expect(run).toMatchObject({
      trigger: 'manual',
      status: 'skipped_unavailable',
      error: NO_DISPATCH_HOST
    })
    expect(store.listAutomations()[0]?.nextRunAt).toBe(dueAt)
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['absent', 'destroyed'] as const)(
    'preserves scheduled refusal for an %s window',
    async (windowState) => {
      const { store, automation, service } = await setup()
      service.setWebContents(
        windowState === 'absent' ? null : { isDestroyed: () => true, send: vi.fn() }
      )
      service.start()
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(store.listAutomations()[0]?.nextRunAt).toBe(nextDay))
      expect(store.listAutomationRuns(automation.id)).toEqual([
        expect.objectContaining({ status: 'skipped_unavailable', error: NO_DISPATCH_HOST })
      ])
    }
  )
})
