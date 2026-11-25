import { expect, it } from 'vitest'
import type { JournalConnectorReplyFill } from '../../../../shared/agent-session/journal/journal-connector-reply'
import { JournalSqlConnectorReplies } from './journal-sql-connector-replies'

// RR-C1-08: every reply write carries its admit to the writer, which asks it last, just before the
// request is posted (journal-sql-owner-admit.test): one a dispose made stale while it waited on the
// lane is dropped unwritten. The writer here answers as the owner does: null when not admitted.

function laneHeld() {
  const queued: (() => Promise<void>)[] = []
  const written: string[] = []
  const writer = {
    maintain: async (operation: { kind: string; fills?: unknown[] }, admit?: () => boolean) => {
      if (admit?.() === false) {
        return null
      }
      written.push(operation.kind)
      return operation.kind === 'connector-replies-fill-each'
        ? operation.fills!.map(() => true)
        : true
    }
  }
  const db = {
    readOnly: false,
    readers: {},
    serialize: <T>(_lane: string, task: (target: typeof writer) => Promise<T> | T) =>
      new Promise<T>((resolve) => queued.push(async () => resolve(await task(writer))))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper calls only serialize and readOnly here.
  const replies = new JournalSqlConnectorReplies(db as never)
  return {
    replies,
    written,
    dispatch: async () => Promise.all(queued.splice(0).map((run) => run()))
  }
}

const fill: JournalConnectorReplyFill = {
  account: 'account-a',
  deliveryId: 'd1',
  outcome: 'quiet',
  answerDeliveryId: 'd1'
}
const key = { account: 'account-a', deliveryId: 'd1' }

it('drops every reply write whose admit turned false while it waited on the lane', async () => {
  const { replies, written, dispatch } = laneHeld()
  let current = true
  const admit = () => current
  const cut = { turnId: 't1', kind: 'restart' as const }
  const results = Promise.all([
    replies.fillOutcomes([fill], admit),
    replies.fillEach([fill], admit),
    replies.cut({ keys: [key], cut }, admit),
    replies.recut('c1', cut, undefined, admit),
    replies.holdForRetry({ keys: [key], claims: [], cut }, admit)
  ])
  current = false
  await dispatch()
  expect([await results, written]).toEqual([[false, [false], false, false, false], []])
})

it('writes a queued batch whose admit still holds, with each fill’s own result', async () => {
  const { replies, written, dispatch } = laneHeld()
  const result = replies.fillEach([fill, { ...fill, deliveryId: 'd2' }], () => true)
  await dispatch()
  expect([await result, written]).toEqual([[true, true], ['connector-replies-fill-each']])
})
