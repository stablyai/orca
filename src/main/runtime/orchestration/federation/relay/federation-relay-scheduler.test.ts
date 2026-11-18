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
    const moved = outbox.length > 0
    inbox.push(...outbox.splice(0))
    return moved ? 'moved' : 'idle'
  }
  const tick = async (): Promise<FederationRelayTickOutcome> => {
    if (holdNextTick) {
      holdNextTick = false
      await new Promise<void>((resolve) => (pendingTick = { finish: resolve }))
      return 'failed'
    }
    return deliver()
  }
  let pulls = 0
  return {
    outbox,
    inbox,
    tick: () => {
      pulls += 1
      return tick()
    },
    pulls: () => pulls,
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

  it('delivers worker mail within a second while a coordinator waits on an idle relay', async () => {
    const mailbox = relayedMailbox()
    mailbox.recover()
    const relays = new FederationRelayScheduler(mailbox.tick)
    relays.arm('dispatch-1', 'env-1')
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    relays.keepAwake('dispatch-1', 'env-1')
    for (let rearm = 0; rearm < 8; rearm += 1) {
      await vi.advanceTimersByTimeAsync(15_000)
      relays.keepAwake('dispatch-1', 'env-1')
    }
    mailbox.outbox.push('worker_done')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(mailbox.inbox).toEqual(['worker_done'])
    relays.clear()
  })

  it('keeps an offline server at two attempts a minute while a coordinator waits', async () => {
    const mailbox = relayedMailbox()
    const relays = new FederationRelayScheduler(mailbox.tick)
    relays.arm('dispatch-1', 'env-1')
    const rearm = setInterval(() => relays.keepAwake('dispatch-1', 'env-1'), 15_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    const before = mailbox.pulls()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(mailbox.pulls() - before).toBe(2)
    clearInterval(rearm)
    relays.clear()
  })
})
