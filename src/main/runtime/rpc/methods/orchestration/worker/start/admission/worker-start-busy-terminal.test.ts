import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFollowUpDispatch } from '../../../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../../../orchestration/terminal-authority/release/worker-terminal-auto-release-scheduler'
import { createOrchestrationWorkerReleaseHarness } from '../../testing/worker-release.test-support'

describe('worker-start onto a terminal another Dispatch holds', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
  })

  const rows = () =>
    h.db.db
      .prepare(
        'SELECT (SELECT count(*) FROM tasks) AS tasks, (SELECT count(*) FROM dispatch_contexts) AS dispatches'
      )
      .get()
  const startOnWorker = () =>
    h.call('orchestration.workerStart', {
      from: 'term_coord',
      terminal: 'term_worker',
      spec: 'next task'
    })
  const send = (dispatchId: string) =>
    h.call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'More',
      body: 'and the docs'
    })
  /** Holds the next readiness wait on the reused terminal until released. */
  const holdReadiness = () => {
    const held = h.deferred<void>()
    const wait = vi.mocked(h.runtime.waitForTerminal).getMockImplementation()
    vi.mocked(h.runtime.waitForTerminal).mockImplementationOnce(async (...args) => {
      await held.promise
      return wait!(...args)
    })
    return held
  }

  it('is refused before any Task, Dispatch or readiness wait, naming the open Dispatch', async () => {
    h.setup()
    const { dispatchId } = await h.startWorker()
    const before = rows()
    const waits = vi.mocked(h.runtime.waitForTerminal).mock.calls.length

    const refusal = await startOnWorker().catch((error: unknown) => error)

    expect(refusal).toMatchObject({
      code: 'terminal_busy',
      data: { effectsApplied: false, dispatchId }
    })
    expect(refusal).toMatchObject({
      message: expect.stringContaining(`send --to dispatch:${dispatchId}`)
    })
    expect(refusal).toMatchObject({
      message: expect.stringContaining(`worker-stop --dispatch ${dispatchId}`)
    })
    expect(rows()).toEqual(before)
    expect(vi.mocked(h.runtime.waitForTerminal).mock.calls).toHaveLength(waits)
  })

  it('refuses worker-start while a follow-up is starting on the finished worker', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const held = holdReadiness()
    const followUp = send(dispatchId)
    await vi.waitFor(() => expect(getFollowUpDispatch(h.db, dispatchId)).toBeDefined())
    const followUpId = getFollowUpDispatch(h.db, dispatchId)!.id

    await expect(startOnWorker()).rejects.toMatchObject({
      code: 'terminal_busy',
      data: { effectsApplied: false, dispatchId: followUpId }
    })
    held.resolve()
    await expect(followUp).resolves.toMatchObject({ state: 'ready', dispatchId: followUpId })
  })

  it('refuses the follow-up a send would start while worker-start is starting there', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const dispatches = h.db.db.prepare('SELECT * FROM dispatch_contexts').all().length
    const held = holdReadiness()
    const start = startOnWorker()
    await vi.waitFor(() => expect(rows()).toMatchObject({ dispatches: dispatches + 1 }))

    await expect(send(dispatchId)).rejects.toMatchObject({
      code: 'terminal_busy',
      data: { effectsApplied: false }
    })
    expect(getFollowUpDispatch(h.db, dispatchId)).toBeUndefined()
    held.resolve()
    await expect(start).resolves.toMatchObject({ state: 'ready' })
  })
})
