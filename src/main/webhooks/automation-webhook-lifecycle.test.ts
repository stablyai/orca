import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { bindAutomationWebhookLifecycle } from './automation-webhook-lifecycle'

const receiver = vi.hoisted(() => ({ apply: vi.fn(), stop: vi.fn(), getEndpoint: vi.fn() }))
vi.mock('./webhook-server', () => ({
  WebhookServer: class {
    apply = receiver.apply
    stop = receiver.stop
    getEndpoint = receiver.getEndpoint
  }
}))

function fixture() {
  const settings = { enabled: true, bindAddress: '127.0.0.1', port: 8473 }
  let changed: ((updates: Partial<GlobalSettings>) => void) | undefined
  const unsubscribe = vi.fn()
  const service = { start: vi.fn(), stop: vi.fn(), getWebhookEndpoint: null }
  const store = {
    getSettings: () => ({ webhookServer: settings }),
    onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => {
      changed = listener
      return unsubscribe
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this lifecycle reads only the scheduler methods and endpoint callback.
  const scheduler = service as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receiver is mocked; lifecycle uses only settings and its subscription.
  bindAutomationWebhookLifecycle(scheduler, store as never)
  return {
    service,
    settings,
    unsubscribe,
    changed: (updates: Partial<GlobalSettings>) => changed?.(updates)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  receiver.apply.mockResolvedValue(undefined)
})

describe('automation webhook lifecycle', () => {
  it('starts once, follows settings, and unsubscribes when the scheduler stops', async () => {
    const f = fixture()
    expect(receiver.apply).not.toHaveBeenCalled()
    f.service.start()
    f.service.start()
    await vi.waitFor(() => expect(receiver.apply).toHaveBeenCalledTimes(1))
    f.settings.port = 9000
    f.changed({ webhookServer: f.settings })
    await vi.waitFor(() => expect(receiver.apply).toHaveBeenCalledTimes(2))
    expect(receiver.apply).toHaveBeenLastCalledWith(f.settings)
    f.service.stop()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(receiver.stop).toHaveBeenCalled()
    f.changed({ webhookServer: f.settings })
    await Promise.resolve()
    expect(receiver.apply).toHaveBeenCalledTimes(2)
  })

  it('does not start a listener queued before a stop', async () => {
    const f = fixture()
    f.service.start()
    f.service.stop()
    await Promise.resolve()
    expect(receiver.apply).not.toHaveBeenCalled()
  })

  it('serializes settings changes and closes a bind that finishes after stop', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    receiver.apply.mockReturnValueOnce(gate.promise)
    f.service.start()
    await vi.waitFor(() => expect(receiver.apply).toHaveBeenCalledTimes(1))
    f.settings.port = 9000
    f.changed({ webhookServer: f.settings })
    await Promise.resolve()
    expect(receiver.apply).toHaveBeenCalledTimes(1)
    f.service.stop()
    gate.resolve()
    await vi.waitFor(() => expect(receiver.stop).toHaveBeenCalledTimes(2))
    expect(receiver.apply).toHaveBeenCalledTimes(1)
  })
})
