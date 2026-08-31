/**
 * Run and usage writes are the highest-frequency events in the system, so they
 * carry the host they belong to: an unscoped one refetches every host in the
 * catalog.
 */
import { describe, expect, it, vi } from 'vitest'
import { createAutomationRunWriter } from './automation-run-writer'
import { AutomationService } from './service'
import type { Store } from '../persistence'
import type { Automation, AutomationRun } from '../../shared/automations-types'

const SSH_SELECTOR = { kind: 'ssh', targetId: 'ssh-1' } as const

function writerWith(selector: ReturnType<Store['automationChangeSelector']>) {
  const publish = vi.fn()
  const automationChangeSelector = vi.fn(() => selector)
  const store = {
    createAutomationRun: vi.fn(() => ({ id: 'run-1', automationId: 'auto-1' }) as AutomationRun),
    updateAutomationRun: vi.fn(() => ({ id: 'run-1', automationId: 'auto-1' }) as AutomationRun),
    automationChangeSelector
  } as unknown as Store
  return {
    publish,
    automationChangeSelector,
    writer: createAutomationRunWriter(store, publish),
    store
  }
}

describe('automation run writer publications', () => {
  it('names the host a created run belongs to', () => {
    const { writer, publish } = writerWith(SSH_SELECTOR)
    writer.createRun({ id: 'auto-1' } as Automation, 0, 'scheduled')
    expect(publish).toHaveBeenCalledWith({ reason: 'run', selector: SSH_SELECTOR })
  })

  it('resolves the host from the written run, which is all a dispatch result names', () => {
    const { writer, publish, automationChangeSelector } = writerWith(SSH_SELECTOR)
    writer.updateRun({ runId: 'run-1', status: 'completed', usage: null })
    expect(automationChangeSelector).toHaveBeenCalledWith('auto-1')
    expect(publish).toHaveBeenCalledWith({ reason: 'run', selector: SSH_SELECTOR })
  })

  it('keeps the usage reason on a usage-bearing write', () => {
    const { writer, publish } = writerWith({ kind: 'self' })
    writer.updateRun({
      runId: 'run-1',
      status: 'completed',
      usage: { status: 'known' } as AutomationRun['usage']
    })
    expect(publish).toHaveBeenCalledWith({ reason: 'usage', selector: { kind: 'self' } })
  })

  // Over-broad beats silent: a subscriber must still hear that something changed.
  it('falls back to the whole authority when the record can no longer be named', () => {
    const { writer, publish } = writerWith(null)
    writer.createRun({ id: 'auto-1' } as Automation, 0, 'scheduled')
    expect(publish).toHaveBeenCalledWith({ reason: 'run' })
  })

  it('does not project a selector nobody will hear', () => {
    const automationChangeSelector = vi.fn(() => SSH_SELECTOR)
    const store = {
      createAutomationRun: vi.fn(() => ({ id: 'run-1', automationId: 'auto-1' }) as AutomationRun),
      automationChangeSelector
    } as unknown as Store
    createAutomationRunWriter(store, null).createRun({ id: 'auto-1' } as Automation, 0, 'scheduled')
    expect(automationChangeSelector).not.toHaveBeenCalled()
  })

  // Why the renderer dispatch path no longer emits its own: the scoped event is
  // published during the write, so it is queued before the reply the caller awaits.
  it('publishes before markDispatchResult settles', async () => {
    const publish = vi.fn()
    const store = {
      updateAutomationRun: vi.fn(
        () => ({ id: 'run-1', automationId: 'auto-1', status: 'dispatched' }) as AutomationRun
      ),
      automationChangeSelector: vi.fn(() => SSH_SELECTOR)
    } as unknown as Store
    const service = new AutomationService(store, { onAutomationsChanged: publish })

    const settled = service.markDispatchResult({ runId: 'run-1', status: 'dispatched' })

    expect(publish).toHaveBeenCalledWith({ reason: 'run', selector: SSH_SELECTOR })
    await settled
  })
})
