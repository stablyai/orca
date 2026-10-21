/**
 * Run and usage writes are the highest-frequency events in the system, so they
 * carry the host they belong to: an unscoped one refetches every host in the
 * catalog.
 */
import { describe, expect, it, vi } from 'vitest'
import { createAutomationRunWriter } from './automation-run-writer'
import { collectAutomationRunUsage } from './run-usage-collection'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'
import type { Store } from '../persistence'

const SSH_SELECTOR = { kind: 'ssh', targetId: 'ssh-1' } as const

const data = buildProfileStateCutoverFixture('/fixture')
const automation = { ...data.automations[0], id: 'auto-1' }
const run = { ...data.automationRuns[0], id: 'run-1', automationId: automation.id }

function writerWith(selector: ReturnType<Store['automationChangeSelector']>) {
  const publish = vi.fn()
  const automationChangeSelector = vi.fn(() => selector)
  const store = {
    flushPendingOrThrowAsync: vi.fn().mockResolvedValue(undefined),
    createAutomationRun: vi.fn(() => run),
    updateAutomationRun: vi.fn(() => run),
    recordRepeatedAutomationSkip: vi.fn(() => null),
    advanceAutomationNextRun: vi.fn(() => automation),
    automationChangeSelector
  }
  return {
    publish,
    automationChangeSelector,
    writer: createAutomationRunWriter(store, publish),
    store
  }
}

describe('automation run writer publications', () => {
  it('waits for durable acknowledgement before publishing or returning a run', async () => {
    const { store, writer, publish } = writerWith(SSH_SELECTOR)
    const acknowledgement = Promise.withResolvers<void>()
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockReturnValue(acknowledgement.promise)
    const completed = vi.fn()
    const pending = writer.updateRun({ runId: 'run-1', status: 'dispatching' }).then(completed)
    await Promise.resolve()
    expect(publish).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
    acknowledgement.resolve()
    await pending
    expect(publish).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledOnce()
  })

  it('rejects a failed write without publishing success', async () => {
    const { store, writer, publish } = writerWith(SSH_SELECTOR)
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValue(new Error('disk full'))
    await expect(writer.updateRun({ runId: 'run-1', status: 'completed' })).rejects.toThrow(
      'disk full'
    )
    expect(publish).not.toHaveBeenCalled()
  })

  it('names the host a created run belongs to', async () => {
    const { writer, publish } = writerWith(SSH_SELECTOR)
    await writer.createRun(automation, 0, 'scheduled')
    expect(publish).toHaveBeenCalledWith({ reason: 'run', selector: SSH_SELECTOR })
  })

  it('resolves the host from the written run, which is all a dispatch result names', async () => {
    const { writer, publish, automationChangeSelector } = writerWith(SSH_SELECTOR)
    await writer.updateRun({ runId: 'run-1', status: 'completed', usage: null })
    expect(automationChangeSelector).toHaveBeenCalledWith('auto-1')
    expect(publish).toHaveBeenCalledWith({ reason: 'run', selector: SSH_SELECTOR })
  })

  it('keeps the usage reason on a usage-bearing write', async () => {
    const { writer, publish } = writerWith({ kind: 'self' })
    await writer.updateRun({
      runId: 'run-1',
      status: 'completed',
      usage: await collectAutomationRunUsage({
        automation,
        run,
        claudeUsage: null,
        codexUsage: null
      })
    })
    expect(publish).toHaveBeenCalledWith({ reason: 'usage', selector: { kind: 'self' } })
  })

  // Over-broad beats silent: a subscriber must still hear that something changed.
  it('falls back to the whole authority when the record can no longer be named', async () => {
    const { writer, publish } = writerWith(null)
    await writer.createRun(automation, 0, 'scheduled')
    expect(publish).toHaveBeenCalledWith({ reason: 'run' })
  })

  it('does not project a selector nobody will hear', async () => {
    const { store, automationChangeSelector } = writerWith(SSH_SELECTOR)
    await createAutomationRunWriter(store, null).createRun(automation, 0, 'scheduled')
    expect(automationChangeSelector).not.toHaveBeenCalled()
  })
})
