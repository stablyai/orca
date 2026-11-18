import { afterEach, describe, expect, it, vi } from 'vitest'
import { UtilityWorkerRelayBudget } from './utility-worker-relay-budget'

const MB = 2 ** 20

/** Each worker's first message (its ready) goes at once; start them so later replies can be held. */
function budgetOf(limit: number, workers: number[], now = () => 0) {
  const sent: string[] = []
  const expired: number[] = []
  let seq = 0
  const budget = new UtilityWorkerRelayBudget(
    (id, bytes, replySeq) => {
      sent.push(`${id}:${bytes.byteLength}`)
      seq = replySeq ?? seq
    },
    (id) => expired.push(id),
    now
  )
  budget.setLimit(limit)
  for (const id of workers) {
    budget.offer(id, new Uint8Array(1))
    budget.ack(seq)
  }
  sent.length = 0
  return { budget, sent, expired, lastSeq: () => seq }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UtilityWorkerRelayBudget', () => {
  it('holds replies past the budget until main acks earlier ones', () => {
    const { budget, sent, lastSeq } = budgetOf(4 * MB, [1, 2])
    budget.offer(1, new Uint8Array(3 * MB))
    budget.offer(2, new Uint8Array(3 * MB))
    expect(sent).toEqual([`1:${3 * MB}`])
    const first = lastSeq()
    budget.ack(first)
    budget.ack(first)
    expect(sent).toEqual([`1:${3 * MB}`, `2:${3 * MB}`])
  })

  it('sends a reply larger than the whole budget only when nothing else is outstanding', () => {
    const { budget, sent, lastSeq } = budgetOf(4 * MB, [1])
    budget.offer(1, new Uint8Array(1 * MB))
    budget.offer(1, new Uint8Array(9 * MB))
    expect(sent).toEqual([`1:${MB}`])
    budget.ack(lastSeq())
    expect(sent).toEqual([`1:${MB}`, `1:${9 * MB}`])
  })

  it("sends a new worker's first message while other replies wait for room", () => {
    const { budget, sent } = budgetOf(4 * MB, [1])
    budget.offer(1, new Uint8Array(4 * MB))
    budget.offer(1, new Uint8Array(1))
    budget.offer(2, new Uint8Array(16))
    expect(sent).toEqual([`1:${4 * MB}`, '2:16'])
  })

  it("keeps a worker's exit behind its own held replies, not behind another worker's", () => {
    const { budget, sent, lastSeq } = budgetOf(4 * MB, [1, 2, 3])
    budget.offer(1, new Uint8Array(4 * MB))
    budget.offer(2, new Uint8Array(1))
    budget.after(2, () => sent.push('2:exit'))
    budget.after(3, () => sent.push('3:exit'))
    expect(sent).toEqual([`1:${4 * MB}`, '3:exit'])
    budget.ack(lastSeq())
    expect(sent).toEqual([`1:${4 * MB}`, '3:exit', '2:1', '2:exit'])
  })

  it('fails the worker whose reply waited too long and drops what it posts afterwards', () => {
    vi.useFakeTimers()
    let clock = 0
    const { budget, sent, expired, lastSeq } = budgetOf(4 * MB, [1, 2], () => clock)
    budget.offer(1, new Uint8Array(4 * MB))
    budget.offer(2, new Uint8Array(1 * MB))
    budget.after(2, () => expired.push(-2))
    clock = 60_000
    vi.advanceTimersByTime(60_000)
    // The failure reaches main before the exit the worker queued behind its reply.
    expect(expired).toEqual([2, -2])
    budget.offer(2, new Uint8Array(1))
    budget.ack(lastSeq())
    expect(sent).toEqual([`1:${4 * MB}`])
  })
})
