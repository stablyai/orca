import { describe, expect, it, vi } from 'vitest'
import { receipt, useHelperFollowUpCli } from './helper-follow-up-cli.test-support'

describe('worker-stop through CLI argv, RPC and SQLite', () => {
  const f = useHelperFollowUpCli()
  const { h, cli, success, start, report } = f

  it('stops every helper under the worker and lists the finished and kept-open ones', async () => {
    const worker = await start('term_coord', 'term_worker')
    const helper = await start('term_worker', 'term_helper')
    const nested = await start('term_helper', 'term_nested')
    const kept = await start('term_worker', 'term_kept')
    const keptChild = await start('term_kept', 'term_kept_child')
    const keptDone = await start('term_kept', 'term_kept_done')
    await report('term_kept_done', keptDone, `dispatch:${kept.dispatchId}`)
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
      expect.objectContaining({
        dispatchId: keptChild.dispatchId,
        outcome: 'kept_open',
        keptOpenBy: kept.dispatchId
      }),
      expect.objectContaining({ dispatchId: keptDone.dispatchId, outcome: 'already_finished' }),
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

  it('stops a helper that was still starting when its creator stopped, once its start ends', async () => {
    const worker = await start('term_coord', 'term_worker')
    const ready = h.deferred<void>()
    const wait = vi.mocked(h.runtime.waitForTerminal).getMockImplementation()
    vi.mocked(h.runtime.waitForTerminal).mockImplementationOnce(async (...args) => {
      await ready.promise
      return wait!(...args)
    })
    f.nextTerminal = 'term_late'
    const starting = cli(
      'worker-start',
      '--from',
      'term_worker',
      '--spec',
      'late',
      '--agent',
      'codex'
    )
    await vi.waitFor(() => expect(h.runtime.createTerminal).toHaveBeenCalledTimes(2))

    const stopped = await success('worker-stop', '--dispatch', worker.dispatchId)
    expect(stopped).toHaveProperty('helpers', [expect.objectContaining({ outcome: 'starting' })])
    ready.resolve()
    const late = receipt.parse((await starting).result)

    expect(h.db.getWorkerDispatch(late.dispatchId)?.state).toBe('stopped')
  })

  it('still stops the helpers of a helper whose own stop cannot run', async () => {
    const worker = await start('term_coord', 'term_worker')
    const helper = await start('term_worker', 'term_helper')
    const nested = await start('term_helper', 'term_nested')
    h.db.beginWorkerStop(helper.dispatchId, h.runtime.getRuntimeId())
    h.db.markWorkerStopUnknown(helper.dispatchId, 'close not proven')

    const result = await cli('worker-stop', '--dispatch', worker.dispatchId)

    expect(process.exitCode).toBe(1)
    expect(h.db.getWorkerDispatch(nested.dispatchId)?.state).toBe('stopped')
    expect(result.result).toHaveProperty('helpers', [
      expect.objectContaining({ dispatchId: helper.dispatchId, outcome: 'unconfirmed' }),
      expect.objectContaining({ dispatchId: nested.dispatchId, outcome: 'stopped' })
    ])
  })

  it('stops a helper whose start was cut off by a restart', async () => {
    const worker = await start('term_coord', 'term_worker')
    const helper = await start('term_worker', 'term_helper')
    h.db.db
      .prepare(
        "UPDATE worker_dispatches SET state = 'starting', runtime_epoch = 'runtime_before_restart' WHERE dispatch_id = ?"
      )
      .run(helper.dispatchId)

    const stopped = await success('worker-stop', '--dispatch', worker.dispatchId)

    expect(stopped).toHaveProperty('helpers', [
      expect.objectContaining({ dispatchId: helper.dispatchId, outcome: 'stopped' })
    ])
    expect(h.db.getWorkerDispatch(helper.dispatchId)?.state).toBe('stopped')
  })
})
