import { describe, expect, it } from 'vitest'
import { PushPromptCategoryGate } from './push-prompt-category-gate'

const HOUR = 60 * 60 * 1000

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('PushPromptCategoryGate', () => {
  it('stays closed until a positive probe, then keeps that answer for six hours', async () => {
    let now = 1_000
    let answer = true
    let probes = 0
    const gate = new PushPromptCategoryGate(
      async () => {
        probes += 1
        return answer
      },
      () => now,
      () => undefined
    )
    expect(gate.allows()).toBe(false)
    gate.refresh()
    await flush()
    expect(gate.allows()).toBe(true)
    answer = false
    now += HOUR
    gate.refresh()
    await flush()
    expect(probes).toBe(1)
    expect(gate.allows()).toBe(true)
    now += 6 * HOUR
    gate.refresh()
    await flush()
    expect(probes).toBe(2)
    expect(gate.allows()).toBe(false)
  })

  it('retries a miss or an error after a minute', async () => {
    let now = 5_000
    let probes = 0
    const gate = new PushPromptCategoryGate(
      async () => {
        probes += 1
        if (probes === 1) {
          throw new Error('offline')
        }
        return true
      },
      () => now,
      () => undefined
    )
    gate.refresh()
    await flush()
    expect(gate.allows()).toBe(false)
    now += 30_000
    gate.refresh()
    await flush()
    expect(probes).toBe(1)
    now += 31_000
    gate.refresh()
    await flush()
    expect(probes).toBe(2)
    expect(gate.allows()).toBe(true)
  })

  it('forces the new fields from the env without probing', () => {
    let probes = 0
    const gate = new PushPromptCategoryGate(
      async () => {
        probes += 1
        return false
      },
      () => 1,
      () => '1'
    )
    gate.refresh()
    expect(gate.allows()).toBe(true)
    expect(probes).toBe(0)
  })
})
