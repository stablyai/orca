import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('orchestration.send between terminals in no Run', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  it('delivers terminal-to-terminal mail when neither terminal is in a Run', async () => {
    // Two plain panes and `send --to <handle>`: the first command the guide teaches. #19542
    // refused this with a bare "Run is required"; it files under the unbound Run instead.
    const { db, runtime, ctx } = h.setup(false)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_a' ? 'tab_a:leaf_a' : handle === 'term_b' ? 'tab_b:leaf_b' : null
    )
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

    const result = (await h.call(
      'orchestration.send',
      { from: 'term_a', to: 'term_b', subject: 'hello from no Run' },
      ctx
    )) as { message: { id: string; run_id: string; to_handle: string } }

    expect(result.message).toMatchObject({ run_id: 'run_unbound', to_handle: 'term_b' })
    expect(db.getRun('run_unbound')).toMatchObject({ legacy: 0 })
    expect(db.getUnreadMessages('term_b').map((row) => row.id)).toEqual([result.message.id])
    const checked = (await h.call('orchestration.check', { terminal: 'term_b' }, ctx)) as {
      messages: { id: string }[]
    }
    expect(checked.messages.map((row) => row.id)).toEqual([result.message.id])
  })
})
