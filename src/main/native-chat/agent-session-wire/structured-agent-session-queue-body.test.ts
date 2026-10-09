import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_SESSION_QUEUE_REPLY_MAX_BYTES } from '../../../shared/agent-session-queue-pages'
import {
  PAGE_SESSION,
  pageMessage,
  queuePageRig,
  type QueuePageRig
} from './agent-session-queue-pages.test-fixture'

let rig: QueuePageRig
beforeEach(async () => {
  rig = await queuePageRig()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rig.close()
})

it.each(['x'.repeat(256 * 1024), '\u0000"\\🦦漢'.repeat(150000), '\ud800'.repeat(90000)])(
  'reassembles the complete stored body losslessly within each actual reply budget',
  async (text) => {
    const body = {
      ...pageMessage(text),
      blocks: [
        { type: 'text' as const, text },
        { type: 'text' as const, text: 'end 🦦' }
      ],
      from: {
        kind: 'agent' as const,
        senders: [],
        orchestration: {
          message: 'task' as const,
          taskId: 'task'.repeat(100000),
          runId: 'run',
          dispatchId: 'dispatch'
        }
      }
    }
    const id = '"\\'.repeat(250)
    await rig.insert(id, body)
    let current = rig.body(id)
    let json = ''
    let parts = 0
    for (;;) {
      expect(Buffer.byteLength(JSON.stringify(rig.wrapped(current)))).toBeLessThanOrEqual(
        AGENT_SESSION_QUEUE_REPLY_MAX_BYTES
      )
      if (current.status !== 'body') {
        throw new Error('body read did not advance')
      }
      expect(current.part.offset).toBe(json.length)
      expect(current.part.json.length).toBeGreaterThan(0)
      json += current.part.json
      parts++
      if (!current.nextCursor) {
        break
      }
      current = rig.body(id, { cursor: current.nextCursor })
    }
    expect(parts).toBeGreaterThan(1)
    expect(JSON.parse(json)).toEqual(body)
    expect(json).toBe(
      rig.db
        .prepare('SELECT body_json FROM queued_messages WHERE session_id = ? AND message_id = ?')
        .get(PAGE_SESSION, id)?.body_json
    )
  }
)

it('reads a normal body in one part without parsing it, through one short transaction', async () => {
  const body = pageMessage('exact original 🦦')
  await rig.insert('normal', body)
  const parse = vi.spyOn(JSON, 'parse')
  const exec = vi.spyOn(rig.db, 'exec')
  const result = rig.body('normal')
  expect(result).toMatchObject({
    status: 'body',
    part: { offset: 0, json: JSON.stringify(body) },
    nextCursor: null
  })
  expect(parse).not.toHaveBeenCalled()
  expect(exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
})

it('answers gone, handed-off and state-changed as readable outcomes', async () => {
  await rig.insert('draft')
  expect(rig.body('draft', { expectedState: 'returned' })).toMatchObject({
    status: 'state-changed',
    state: 'waiting'
  })
  rig.db
    .prepare(
      "UPDATE queued_messages SET state = 'dispatched', consumed_as = 'submission' WHERE message_id = 'draft'"
    )
    .run()
  expect(rig.body('draft')).toMatchObject({ status: 'handed-off' })
  rig.db.prepare("UPDATE queued_messages SET state = 'withdrawn' WHERE message_id = 'draft'").run()
  expect(rig.body('draft')).toMatchObject({ status: 'gone' })
  expect(rig.body('missing')).toMatchObject({ status: 'gone' })
})

it('resets foreign and retired body cursors rather than returning truncated editable text', async () => {
  await rig.insert('huge', pageMessage('🦦'.repeat(300000)))
  await rig.insert('other')
  const first = rig.body('huge')
  if (first.status !== 'body' || !first.nextCursor) {
    throw new Error('expected body parts')
  }
  expect(rig.body('other', { cursor: first.nextCursor }).status).toBe('stale')
  expect(rig.body('huge', { cursor: 'bad' }).status).toBe('stale')
  await rig.journal.rollEpoch('handle_forked', 1)
  expect(rig.body('huge', { cursor: first.nextCursor })).toMatchObject({ status: 'stale' })
  expect(rig.body('huge').generation).not.toBe(first.generation)
})
