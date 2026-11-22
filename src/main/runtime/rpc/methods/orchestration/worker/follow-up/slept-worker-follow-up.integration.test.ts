import { describe, expect, it, vi } from 'vitest'
import { receipt, useHelperFollowUpCli } from '../testing/helper-follow-up-cli.test-support'
import '../worker-stop'

describe('a follow-up to a worker whose agent Agent Sleep stopped', () => {
  const f = useHelperFollowUpCli()
  const { h, success, start, report, follow } = f

  it('reopens it in a terminal Orca owns, which Orca can still stop and close', async () => {
    const worker = await start('term_coord', 'term_worker')
    await report('term_worker', worker, 'term_coord')
    const sleptPane = h.runtime.getTerminalPaneKey('term_worker')
    const closed = () => vi.mocked(h.runtime.closeTerminal).mock.calls.map(([handle]) => handle)
    vi.spyOn(h.runtime, 'sleptAgentHandleForPane').mockImplementation((pane) =>
      pane === sleptPane && !closed().includes('term_worker') ? 'term_worker' : null
    )
    vi.mocked(h.runtime.createTerminal).mockImplementationOnce(async () => ({
      handle: 'term_resumed',
      worktreeId: 'repo::worktree',
      title: 'term_resumed'
    }))

    const sent = await follow('term_coord', worker.dispatchId)
    expect(sent.error).toBeUndefined()
    const next = receipt.parse(sent.result)

    expect(closed()).toContain('term_worker')
    expect(h.db.getWorkerTerminalResourceByOwner(next.dispatchId)).toMatchObject({
      terminal_handle: 'term_resumed',
      ownership_state: 'owned'
    })
    const stopped = await success('worker-stop', '--dispatch', next.dispatchId)
    expect(stopped).toMatchObject({ dispatchId: next.dispatchId, state: 'stopped' })
    expect(closed()).toContain('term_resumed')
  })
})
