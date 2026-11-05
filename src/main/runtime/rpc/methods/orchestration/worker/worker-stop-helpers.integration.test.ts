import { describe, expect, it, vi } from 'vitest'
import { useHelperFollowUpCli } from './helper-follow-up-cli.test-support'

describe('worker-stop through CLI argv, RPC and SQLite', () => {
  const { h, cli, success, start, report } = useHelperFollowUpCli()

  it('stops every helper under the worker and lists the finished and kept-open ones', async () => {
    const worker = await start('term_coord', 'term_worker')
    const helper = await start('term_worker', 'term_helper')
    const nested = await start('term_helper', 'term_nested')
    const kept = await start('term_worker', 'term_kept')
    const keptChild = await start('term_kept', 'term_kept_child')
    const finished = await start('term_worker', 'term_finished')
    await report('term_finished', finished, `dispatch:${worker.dispatchId}`)
    h.db.keepWorkerTerminalOpen(h.runtime.getTerminalPaneKey('term_kept')!)

    const stopped = await success('worker-stop', '--dispatch', worker.dispatchId)

    expect(stopped).toMatchObject({ dispatchId: worker.dispatchId, state: 'stopped' })
    expect(stopped).toHaveProperty('helpers', [
      expect.objectContaining({ dispatchId: helper.dispatchId, outcome: 'stopped' }),
      expect.objectContaining({
        dispatchId: nested.dispatchId,
        creatorDispatchId: helper.dispatchId,
        outcome: 'stopped'
      }),
      expect.objectContaining({ dispatchId: kept.dispatchId, outcome: 'kept_open' }),
      expect.objectContaining({ dispatchId: finished.dispatchId, outcome: 'already_finished' })
    ])
    const closed = vi.mocked(h.runtime.closeTerminal).mock.calls.map(([handle]) => handle)
    expect(closed.sort()).toEqual(['term_helper', 'term_nested', 'term_worker'])
    // A kept-open helper keeps working, and so do the helpers working for it.
    expect(h.db.getWorkerDispatch(kept.dispatchId)?.state).toBe('ready')
    expect(h.db.getWorkerDispatch(keptChild.dispatchId)?.state).toBe('ready')
  })

  it('refuses a helper start from a worker whose stop has begun', async () => {
    const worker = await start('term_coord', 'term_worker')
    h.db.beginWorkerStop(worker.dispatchId, h.runtime.getRuntimeId())

    const refused = await cli(
      'worker-start',
      '--from',
      'term_worker',
      '--spec',
      'more',
      '--agent',
      'codex'
    )

    expect(refused.error).toMatchObject({
      code: 'consumer_fenced',
      message: expect.stringContaining('is being stopped')
    })
  })
})
