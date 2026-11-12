import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('a worker-start that fails', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  it('tells the coordinator once, with the reason, even if its receipt is never read', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'createTerminal').mockRejectedValue(
      new Error('The host is already running as many terminals as Orca allows.')
    )
    const task = h.db.createTask({ spec: 'watch CI and merge', runId: h.activeRunId })
    const receipt = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'claude'
    })
    expect(receipt).toMatchObject({ state: 'failed' })

    const mail = h.db.getUnreadRunMailbox(h.activeRunId, 100, ['escalation'])
    expect(mail.map((message) => message.subject)).toEqual(['Worker lost without reporting'])
    expect(mail[0]?.body).toContain(
      'is gone (it never started: The host is already running as many terminals as Orca allows.)'
    )
    expect(mail[0]?.body).not.toContain('still open')
  })
})
