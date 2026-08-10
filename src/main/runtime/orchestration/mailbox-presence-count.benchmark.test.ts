import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

// Why: a supervising harness can afford to ask "is there mail" on every tool call only if the
// answer costs about nothing when it is "no". This bench states what --count actually saves over
// the check it replaces: no Delivery row, no message bodies on the wire, no mark-read.

const BODY = 'x'.repeat(4096)
const PROBES = 1000

function seed(db: OrchestrationDb, runId: string, address: string, count: number): void {
  for (let i = 0; i < count; i++) {
    db.insertMessage({
      from: 'term_worker',
      to: address,
      subject: `report ${i}`,
      body: BODY,
      runId
    })
  }
}

describe('mailbox presence count (benchmark)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('answers an empty mailbox without reading or writing a single message row', () => {
    const target = new OrchestrationDb(':memory:')
    db = target
    const run = target.createRun({
      objective: 'presence bench',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const address = `run:${run.id}`

    const started = performance.now()
    for (let i = 0; i < PROBES; i++) {
      expect(target.countUnreadMessages({ toHandle: address, runId: run.id }).total).toBe(0)
    }
    const elapsedMs = performance.now() - started

    // eslint-disable-next-line no-console
    console.log(
      `[bench] empty-mailbox presence probe: ${PROBES} probes in ${elapsedMs.toFixed(1)}ms (${(
        (elapsedMs / PROBES) *
        1000
      ).toFixed(1)}us each)`
    )
    // No Delivery was created, so a probe can never consume the batch a real check would replay.
    expect(target.getRunMailboxHistory(run.id)).toHaveLength(0)
  })

  it('returns a fixed-size answer where a check returns every queued body', () => {
    const target = new OrchestrationDb(':memory:')
    db = target
    const run = target.createRun({
      objective: 'presence bench',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const address = `run:${run.id}`
    seed(target, run.id, address, 50)

    const counted = target.countUnreadMessages({ toHandle: address, runId: run.id })
    const countBytes = JSON.stringify(counted).length

    const delivery = target.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })
    const checkBytes = JSON.stringify(delivery?.messages ?? []).length

    expect(counted.total).toBe(50)
    expect(delivery?.messages).toHaveLength(50)
    // eslint-disable-next-line no-console
    console.log(
      `[bench] 50 queued 4KB messages: presence answer ${countBytes} bytes vs check payload ${checkBytes} bytes`
    )
    expect(countBytes * 1000).toBeLessThan(checkBytes)
  })

  it('does not mark mail read, so a probe cannot lose a message', () => {
    const target = new OrchestrationDb(':memory:')
    db = target
    const run = target.createRun({
      objective: 'presence bench',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const address = `run:${run.id}`
    seed(target, run.id, address, 3)

    for (let i = 0; i < PROBES; i++) {
      target.countUnreadMessages({ toHandle: address, runId: run.id })
    }

    expect(target.countUnreadMessages({ toHandle: address, runId: run.id }).total).toBe(3)
    expect(target.getRunMailboxHistory(run.id).every((message) => message.read === 0)).toBe(true)
  })
})
