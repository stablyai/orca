import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from '../testing/worker-release.test-support'

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

  it('treats a reuse start that failed before binding as never started', async () => {
    h.setup()
    vi.spyOn(h.runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_reused',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null
    })
    const task = h.db.createTask({ spec: 'follow up on the PR', runId: h.activeRunId })
    const receipt = await h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      terminal: 'term_reused'
    })
    expect(receipt).toMatchObject({ state: 'failed' })
    const dispatchId = h.db.getDispatchContext(task.id)?.id

    const [lost] = h.db.getUnreadRunMailbox(h.activeRunId, 100, ['escalation'])
    expect(lost?.body).not.toContain('worker-read')
    await expect(
      h.call('orchestration.workerRead', { dispatch: dispatchId })
    ).rejects.toMatchObject({
      code: 'worker_never_started',
      message: expect.stringContaining('never started: Agent did not become ready')
    })
  })
})
