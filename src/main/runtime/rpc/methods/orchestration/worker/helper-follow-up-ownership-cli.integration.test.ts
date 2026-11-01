import { describe, expect, it, vi } from 'vitest'
import { getFollowUpDispatch } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { continueAllUnreadWorkerMail } from '../messaging/settled-worker-follow-through'
import { z } from 'zod'
import * as setupGate from './worker-start-structured-setup-gate'
import { receipt, type Started, useHelperFollowUpCli } from './helper-follow-up-cli.test-support'
import { traceDispatchProbes } from './helper-follow-up-sql-trace.test-support'

const failedReceipt = z.object({
  taskId: z.string(),
  dispatchId: z.string(),
  state: z.literal('failed')
})

describe('which helpers a worker may continue, through CLI argv, RPC and SQLite', () => {
  const f = useHelperFollowUpCli()
  const {
    h,
    cli,
    success,
    start,
    report,
    pair,
    follow,
    takeOver,
    continues,
    otherRun,
    effects,
    reopenOn,
    placeNextWorkerInChat
  } = f

  /** A start whose agent never came up, so no Dispatch took custody of anything. */
  async function failedStart(from: string, failure: 'terminal create' | 'native setup gate') {
    if (failure === 'terminal create') {
      vi.mocked(h.runtime.createTerminal).mockRejectedValueOnce(new Error('spawn failed'))
    } else {
      await placeNextWorkerInChat()
      vi.spyOn(setupGate, 'awaitStructuredWorkerSetupGate').mockResolvedValueOnce({
        satisfied: false,
        status: 'exited'
      })
    }
    const failed = failedReceipt.parse(
      (await cli('worker-start', '--from', from, '--spec', 'helper work', '--agent', 'codex'))
        .result
    )
    expect(h.db.getWorkerTerminalResourceByOwner(failed.dispatchId)).toBeUndefined()
    return failed
  }

  /** Coordinator follow-ups that each fail before getting an agent; returns the last. */
  async function failedAttempts(dispatchId: string, count: number, after = dispatchId) {
    let last = after
    for (let attempt = 0; attempt < count; attempt++) {
      vi.mocked(h.runtime.createTerminal).mockRejectedValueOnce(new Error('spawn failed'))
      const failed = failedReceipt.parse((await follow('term_coord', dispatchId)).result)
      expect(h.db.getDispatchContextById(failed.dispatchId)?.follow_up_of_dispatch_id).toBe(last)
      last = failed.dispatchId
    }
    return last
  }

  it.each(['live', 'closed', 'unreadable history'] as const)(
    'lets a worker reopened on its own pane continue its %s helper',
    async (state) => {
      const { worker, helper } = await pair()
      await report('term_worker', worker, 'term_coord')
      if (state === 'closed') {
        await success('worker-release', '--dispatch', helper.dispatchId)
      }
      const reopened = await reopenOn(worker, 'term_worker')
      const custody = h.db.getWorkerTerminalResourceByOwner(reopened.dispatchId)!
      expect(custody).toMatchObject({
        origin_dispatch_id: worker.dispatchId,
        prior_owner_dispatch_ids: JSON.stringify([worker.dispatchId])
      })
      expect(h.db.getDispatchContextById(reopened.dispatchId)?.follow_up_of_dispatch_id).toBeNull()
      if (state === 'unreadable history') {
        h.db.db
          .prepare('UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?')
          .run('not-json', custody.id)
        const before = effects()
        expect((await follow('term_worker', helper.dispatchId)).error).toMatchObject({
          code: 'task_not_found'
        })
        expect(effects()).toEqual(before)
        return
      }
      f.nextTerminal = 'term_helper_again'
      const continued = await continues('term_worker', helper, reopened)
      await report(
        state === 'live' ? 'term_helper' : 'term_helper_again',
        continued,
        `dispatch:${reopened.dispatchId}`
      )
      expect(h.db.getUnreadMessages(`dispatch:${reopened.dispatchId}`)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
      )
    }
  )

  it('follows takeovers and fresh follow-ups together back to the worker that started each helper', async () => {
    const first = await start('term_coord', 'term_worker')
    const early = await start('term_worker', 'term_early')
    await report('term_early', early, `dispatch:${first.dispatchId}`)
    await report('term_worker', first, 'term_coord')
    const second = await takeOver('term_coord', 'term_worker')
    const helper = await start('term_worker', 'term_helper')
    await report('term_helper', helper, `dispatch:${second.dispatchId}`)
    await report('term_worker', second, 'term_coord')
    await success('worker-release', '--dispatch', second.dispatchId)
    f.nextTerminal = 'term_worker_fresh'
    const third = receipt.parse((await follow('term_coord', second.dispatchId)).result)
    expect(h.db.getDispatchContextById(third.dispatchId)?.follow_up_of_dispatch_id).toBe(
      second.dispatchId
    )
    await report('term_worker_fresh', third, 'term_coord')
    const fourth = await takeOver('term_coord', 'term_worker_fresh')
    // Neither the current pane nor its resource's origin names the workers that started these helpers.
    expect(h.db.getWorkerTerminalResourceByOwner(fourth.dispatchId)).toMatchObject({
      origin_dispatch_id: third.dispatchId,
      prior_owner_dispatch_ids: JSON.stringify([third.dispatchId])
    })
    f.nextTerminal = 'term_helper_again'
    await continues('term_worker_fresh', helper, fourth)
    await continues('term_worker_fresh', early, fourth)
  })

  it('refuses the helper of a worker re-placed on the user’s own terminal, which only its coordinator continues', async () => {
    const worker = await takeOver('term_coord', 'term_user')
    const helper = await start('term_user', 'term_user_helper')
    await report('term_user_helper', helper, `dispatch:${worker.dispatchId}`)
    // While at work, the worker continues its own helper.
    const continued = await continues('term_user', helper, worker)
    await report('term_user_helper', continued, `dispatch:${worker.dispatchId}`)
    await report('term_user', worker, 'term_coord')
    // Saved custody records no takeover of the user's terminal, so nothing ties the new start to the old one.
    const reopened = await reopenOn(worker, 'term_user')
    expect(h.db.getWorkerTerminalResourceByOwner(reopened.dispatchId)).toMatchObject({
      ownership_state: 'external',
      prior_owner_dispatch_ids: '[]'
    })
    const before = effects()
    expect((await follow('term_user', helper.dispatchId)).error).toMatchObject({
      code: 'task_not_found',
      data: { effectsApplied: false }
    })
    expect(effects()).toEqual(before)
    expect((await follow('term_coord', helper.dispatchId)).error).toBeUndefined()
  })

  it('refuses a helper whose creator reached the caller only through another Run', async () => {
    const { worker, helper } = await pair()
    await report('term_worker', worker, 'term_coord')
    const elsewhere = otherRun()
    const visitor = await takeOver('term_other_coord', 'term_worker')
    await report('term_worker', visitor, 'term_other_coord')
    const back = await takeOver('term_coord', 'term_worker')
    expect(h.db.getDispatchContextById(visitor.dispatchId)?.run_id).toBe(elsewhere)
    expect(h.db.getWorkerTerminalResourceByOwner(back.dispatchId)?.prior_owner_dispatch_ids).toBe(
      JSON.stringify([worker.dispatchId, visitor.dispatchId])
    )
    const before = effects()
    expect((await follow('term_worker', helper.dispatchId)).error).toMatchObject({
      code: 'task_not_found',
      message: expect.stringContaining(`is not a helper of Dispatch ${back.dispatchId}`)
    })
    expect(effects()).toEqual(before)
  })

  it.each([
    ['placed', 'the original address'],
    ['placed', 'the failed attempt'],
    ['terminal create', 'the original address'],
    ['native setup gate', 'the failed attempt']
  ] as const)(
    'keeps a helper (%s) its worker’s after coordinator attempts that never got an agent, through %s',
    async (helperStart, address) => {
      const worker = await start('term_coord', 'term_worker')
      let helper: Started
      if (helperStart === 'placed') {
        helper = await start('term_worker', 'term_helper')
        await report('term_helper', helper, `dispatch:${worker.dispatchId}`)
        await success('worker-release', '--dispatch', helper.dispatchId)
      } else {
        // The helper's own start failed before any agent came up, so nothing ever took custody.
        helper = await failedStart('term_worker', helperStart)
      }
      const failed = await failedAttempts(helper.dispatchId, 2)
      // The worker's own continuation, a different Dispatch, keeps them.
      await report('term_worker', worker, 'term_coord')
      const continuedWorker = receipt.parse((await follow('term_coord', worker.dispatchId)).result)
      f.nextTerminal = 'term_helper_again'
      const continued = await continues(
        'term_worker',
        { ...helper, dispatchId: address === 'the original address' ? helper.dispatchId : failed },
        continuedWorker
      )
      expect(h.db.getDispatchContextById(continued.dispatchId)?.follow_up_of_dispatch_id).toBe(
        failed
      )
      expect(h.db.getDispatchContextById(helper.dispatchId)?.creator_dispatch_id).toBe(
        worker.dispatchId
      )
      await report('term_helper_again', continued, `dispatch:${continuedWorker.dispatchId}`)
      expect(h.db.getUnreadMessages(`dispatch:${continuedWorker.dispatchId}`)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
      )
    }
  )

  it.each([
    'the coordinator',
    'another worker',
    'a missing predecessor',
    'a cycle',
    'another Run'
  ] as const)(
    'refuses a never-placed helper whose request traces to %s before effects',
    async (origin) => {
      await start('term_coord', 'term_worker')
      if (origin === 'another worker') {
        await start('term_coord', 'term_other')
      }
      const requester =
        origin === 'the coordinator'
          ? 'term_coord'
          : origin === 'another worker'
            ? 'term_other'
            : 'term_worker'
      const helper = await failedStart(requester, 'terminal create')
      const latest = await failedAttempts(helper.dispatchId, 1)
      const corruption: [column: string, value: string] | undefined =
        origin === 'a missing predecessor'
          ? ['follow_up_of_dispatch_id', 'ctx_missing']
          : origin === 'a cycle'
            ? ['follow_up_of_dispatch_id', latest]
            : origin === 'another Run'
              ? ['run_id', otherRun()]
              : undefined
      if (corruption) {
        h.db.db.pragma('foreign_keys = OFF')
        h.db.db
          .prepare(`UPDATE dispatch_contexts SET ${corruption[0]} = ? WHERE id = ?`)
          .run(corruption[1], helper.dispatchId)
      }
      const before = effects()
      const probes = traceDispatchProbes(h.db)
      expect((await follow('term_worker', latest)).error).toMatchObject({
        code: 'task_not_found',
        data: { effectsApplied: false }
      })
      expect(effects()).toEqual(before)
      // Even around a cycle, the walk to the first request reads each Dispatch a bounded number of times.
      expect(probes.counts().perDispatch).toBeLessThanOrEqual(6)
      probes.restore()
    }
  )

  it('continues a never-placed helper from its worker’s mail held on a failed coordinator attempt', async () => {
    const worker = await start('term_coord', 'term_worker')
    const helper = await failedStart('term_worker', 'terminal create')
    const entered = h.deferred<void>()
    const gate = h.deferred<void>()
    vi.mocked(h.runtime.createTerminal).mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
      throw new Error('spawn failed')
    })
    const attempt = follow('term_coord', helper.dispatchId)
    await entered.promise
    // The attempt is still starting, so this is mail it holds.
    expect((await follow('term_worker', helper.dispatchId)).error).toBeUndefined()
    gate.resolve()
    const failed = failedReceipt.parse((await attempt).result)
    f.nextTerminal = 'term_helper_fresh'
    // As at startup: held mail on a finished worker continues it.
    continueAllUnreadWorkerMail(h.runtime, h.db)
    await vi.waitFor(() =>
      expect(getFollowUpDispatch(h.db, failed.dispatchId)?.creator_dispatch_id).toBe(
        worker.dispatchId
      )
    )
  })

  it.each(['succeeded', 'failed and a later attempt never got an agent'] as const)(
    'refuses a helper the coordinator took over, whose continuation %s',
    async (outcome) => {
      const { worker, helper } = await pair()
      const taken = receipt.parse((await follow('term_coord', helper.dispatchId)).result)
      h.settle(taken.taskId, taken.dispatchId, outcome === 'succeeded' ? outcome : 'failed')
      let latest = taken.dispatchId
      if (outcome.endsWith('never got an agent')) {
        await success('worker-release', '--dispatch', taken.dispatchId)
        latest = await failedAttempts(helper.dispatchId, 1, taken.dispatchId)
      }
      const before = effects()
      expect((await follow('term_worker', helper.dispatchId)).error).toMatchObject({
        code: 'task_not_found',
        message: expect.stringContaining(
          `Dispatch ${helper.dispatchId}'s latest work, Dispatch ${latest}, is not a helper of Dispatch ${worker.dispatchId}`
        )
      })
      expect(effects()).toEqual(before)
    }
  )
})
