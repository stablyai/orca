import { describe, expect, it, vi } from 'vitest'
import { createAutomationRunWriter } from './automation-run-writer'
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
})
