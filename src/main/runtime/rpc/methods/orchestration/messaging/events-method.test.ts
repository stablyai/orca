import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const EventsResult = z.object({
  cursor: z.string(),
  events: z.array(
    z.object({
      type: z.string(),
      reason: z.string().optional(),
      cursor: z.string().optional(),
      message: z.object({ subject: z.string() }).optional()
    })
  )
})

describe('orchestration.events', () => {
  const h = createOrchestrationRpcHarness()

  afterEach(() => {
    h.cleanup()
  })

  it('announces Run mail without taking the pointer delivery from the coordinator', async () => {
    const { db, runtime, ctx, activeRunId } = h.setup()
    const deliver = vi
      .spyOn(runtime, 'deliverPendingMessagesForHandle')
      .mockImplementation(() => {})
    const start = EventsResult.parse(
      await h.call('orchestration.events', { runId: activeRunId, terminal: 'term_coord' }, ctx)
    )
    const polling = h.call(
      'orchestration.events',
      { runId: activeRunId, terminal: 'term_coord', sinceCursor: start.cursor, timeoutMs: 5000 },
      ctx
    )

    db.insertMessage({ from: 'term_worker', to: `run:${activeRunId}`, subject: 'Ready for review' })
    runtime.notifyMessageArrived(`run:${activeRunId}`, 'status')

    await expect(polling).resolves.toMatchObject({
      events: [{ type: 'message', message: { subject: 'Ready for review' } }]
    })
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenCalledWith(`run:${activeRunId}`, expect.any(Set))
    )
  })

  it('resumes after a message cursor and reports a cursor from another database as lost', async () => {
    const { db, ctx, activeRunId } = h.setup()
    const call = async (sinceCursor?: string) =>
      EventsResult.parse(
        await h.call(
          'orchestration.events',
          { runId: activeRunId, terminal: 'term_coord', sinceCursor, timeoutMs: 50 },
          ctx
        )
      )
    const start = await call()
    db.insertMessage({ from: 'term_worker', to: `run:${activeRunId}`, subject: 'First' })
    db.insertMessage({ from: 'term_worker', to: `run:${activeRunId}`, subject: 'Second' })

    const both = await call(start.cursor)
    expect(both.events.map((event) => event.message?.subject)).toEqual(['First', 'Second'])
    const resumed = await call(both.events[0].cursor)
    expect(resumed.events.map((event) => event.message?.subject)).toEqual(['Second'])
    expect((await call('999999.other.0')).events).toEqual([
      { type: 'lost', reason: 'cursor_unknown' }
    ])
  })
})
