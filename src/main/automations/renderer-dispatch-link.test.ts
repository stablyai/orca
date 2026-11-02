import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AutomationDispatchRequest } from '../../shared/automations-types'
import { AutomationService } from './service'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

// A reload used to strand the run `dispatching`: only the renderer moves it on.
describe('AutomationService renderer reload during dispatch', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-automations-test-'))
    vi.useFakeTimers()
  })

  afterEach(async () => {
    await closeTestStores()
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const dispatchToFirstDocument = async () => {
    vi.setSystemTime(new Date('2026-05-13T08:59:00'))
    const store = await createStore()
    store.addRepo({ id: 'r1', path: '/repo', displayName: 'test', badgeColor: '#fff', addedAt: 1 })
    const automation = store.createAutomation({
      name: 'Morning check',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: 'r1',
      workspaceMode: 'existing',
      workspaceId: 'r1::wt1',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-05-12T00:00:00').getTime()
    })
    vi.setSystemTime(new Date('2026-05-13T09:01:00'))
    const send = vi.fn<(channel: string, request: AutomationDispatchRequest) => void>()
    const service = new AutomationService(store, { tickMs: 60_000 })
    service.setWebContents({ isDestroyed: () => false, send })
    service.start()
    service.setRendererReady('doc-1')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const [, request] = send.mock.calls[0]
    return { store, automation, service, send, request }
  }

  it('re-sends a run the reloaded document never received', async () => {
    const { store, automation, service, send, request } = await dispatchToFirstDocument()

    // The same document reporting ready again is not a reload.
    service.setRendererReady('doc-1')
    service.setRendererReady('doc-2')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    await service.runInAutomationLane(automation.id, async () => {})
    service.stop()

    const [, resent] = send.mock.calls[1]
    expect(send).toHaveBeenCalledTimes(2)
    expect(resent.run.id).toBe(request.run.id)
    expect(resent.dispatchToken).not.toBe(request.dispatchToken)
    expect(store.listAutomationRuns(automation.id)).toEqual([
      expect.objectContaining({ id: request.run.id, status: 'dispatching' })
    ])
  })

  it('closes out a run the reloaded document had already received', async () => {
    const { store, automation, service, send, request } = await dispatchToFirstDocument()
    service.acknowledgeRendererDispatch(request.run.id, request.dispatchToken)

    service.setRendererReady('doc-2')
    await vi.waitFor(() =>
      expect(store.listAutomationRuns(automation.id)[0]?.status).toBe('dispatch_failed')
    )
    service.stop()

    expect(store.listAutomationRuns(automation.id)[0]?.error).toContain('reloaded')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
