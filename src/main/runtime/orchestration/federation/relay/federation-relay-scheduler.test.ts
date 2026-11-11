import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FederationRelayScheduler,
  type FederationRelayTickOutcome
} from './federation-relay-scheduler'

/** A worker outbox relayed into the coordinator's inbox whenever the worker answers. */
function relayedMailbox() {
  const outbox: string[] = []
  const inbox: string[] = []
  let workerUp = false
  let pendingTick: { finish: () => void } | null = null
  let holdNextTick = false
  const deliver = (): FederationRelayTickOutcome => {
    if (!workerUp) {
      return 'failed'
    }
    inbox.push(...outbox.splice(0))
    return 'synced'
  }
  const tick = async (): Promise<FederationRelayTickOutcome> => {
    if (holdNextTick) {
      holdNextTick = false
      await new Promise<void>((resolve) => (pendingTick = { finish: resolve }))
      return 'failed'
    }
    return deliver()
  }
  return {
    outbox,
    inbox,
    tick,
    holdNextTick: () => {
      holdNextTick = true
    },
    finishHeldTick: () => pendingTick?.finish(),
    recover: () => {
      workerUp = true
    }
  }
}

describe('FederationRelayScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers a worker message that lands while a failing sync is in flight', async () => {
    const mailbox = relayedMailbox()
    const relays = new FederationRelayScheduler(mailbox.tick)
    mailbox.holdNextTick()
    relays.arm('dispatch-1', 'env-1')

    mailbox.recover()
    mailbox.outbox.push('worker_done')
    relays.arm('dispatch-1', 'env-1')
    mailbox.finishHeldTick()
    await vi.advanceTimersByTimeAsync(0)

    expect(mailbox.inbox).toEqual(['worker_done'])
    relays.clear()
  })
})
