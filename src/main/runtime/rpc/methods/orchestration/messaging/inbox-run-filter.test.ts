import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('orchestration.inbox --run', () => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>
  beforeEach(() => {
    state = h.setup()
  })
  afterEach(() => h.cleanup())

  it('lists only the named Run and refuses a Run that does not exist', async () => {
    const other = state.db.createRun({
      objective: 'other',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:33333333-3333-4333-8333-333333333333'
    })
    state.db.insertMessage({ from: 'a', to: `run:${state.activeRunId}`, subject: 'mine' })
    state.db.insertMessage({ from: 'b', to: `run:${other.id}`, subject: 'theirs', runId: other.id })

    expect(await h.call('orchestration.inbox', {}, state.ctx)).toMatchObject({ count: 2 })
    expect(
      await h.call('orchestration.inbox', { run: state.activeRunId }, state.ctx)
    ).toMatchObject({ count: 1, messages: [{ subject: 'mine' }] })
    await expect(
      h.call('orchestration.inbox', { run: `run:${state.activeRunId}` }, state.ctx)
    ).rejects.toMatchObject({
      code: 'run_not_found',
      message: expect.stringContaining('bare Run id')
    })
  })
})
