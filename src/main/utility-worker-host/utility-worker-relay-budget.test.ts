import { afterEach, describe, expect, it, vi } from 'vitest'
import { UtilityWorkerRelayBudget } from './utility-worker-relay-budget'

const MB = 2 ** 20

function budgetOf(limit: number) {
  const relayed: { id: number; size: number; seq?: number }[] = []
  const expired: number[] = []
  const budget = new UtilityWorkerRelayBudget(
    (id, bytes, seq) => relayed.push({ id, size: bytes.byteLength, seq }),
    (id) => expired.push(id)
  )
  budget.setLimit(limit)
  return { budget, relayed, expired }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UtilityWorkerRelayBudget', () => {
  it('holds replies past the budget until main acks earlier ones', () => {
    const { budget, relayed } = budgetOf(4 * MB)
    budget.offer(1, new Uint8Array(3 * MB))
    budget.offer(2, new Uint8Array(3 * MB))
    expect(relayed).toEqual([{ id: 1, size: 3 * MB, seq: 1 }])
    budget.ack(1)
    budget.ack(1)
    expect(relayed).toEqual([
      { id: 1, size: 3 * MB, seq: 1 },
      { id: 2, size: 3 * MB, seq: 2 }
    ])
  })

  it('sends a reply larger than the whole budget only when nothing else is outstanding', () => {
    const { budget, relayed } = budgetOf(4 * MB)
    budget.offer(1, new Uint8Array(1 * MB))
    budget.offer(1, new Uint8Array(9 * MB))
    expect(relayed.map(({ size }) => size)).toEqual([1 * MB])
    budget.ack(1)
    expect(relayed.map(({ size }) => size)).toEqual([1 * MB, 9 * MB])
  })

  it("keeps a worker's exit behind its held replies so main sees its last reply first", () => {
    const sent: string[] = []
    const budget = new UtilityWorkerRelayBudget(
      (id, bytes) => sent.push(`${id}:${bytes.byteLength}`),
      () => undefined
    )
    budget.setLimit(4 * MB)
    budget.offer(1, new Uint8Array(4 * MB))
    budget.offer(2, new Uint8Array(1))
    budget.after(2, () => sent.push('2:exit'))
    expect(sent).toEqual([`1:${4 * MB}`])
    budget.ack(1)
    expect(sent).toEqual([`1:${4 * MB}`, '2:1', '2:exit'])
  })

  it('fails the worker whose reply waited too long, without sending it over budget', () => {
    vi.useFakeTimers()
    const { budget, relayed, expired } = budgetOf(4 * MB)
    budget.offer(1, new Uint8Array(4 * MB))
    budget.offer(2, new Uint8Array(1 * MB))
    vi.advanceTimersByTime(60_000)
    expect(expired).toEqual([2])
    expect(relayed.map(({ id }) => id)).toEqual([1])
    budget.ack(1)
    expect(relayed.map(({ id }) => id)).toEqual([1])
  })
})
