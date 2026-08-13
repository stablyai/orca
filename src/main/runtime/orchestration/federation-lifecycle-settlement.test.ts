import { describe, expect, it } from 'vitest'
import {
  areFederatedLifecycleSettlementsEqual,
  type FederatedLifecycleSettlement
} from './federation-lifecycle-settlement'

const rejected = (reason: string): FederatedLifecycleSettlement => ({
  action: 'rejected',
  code: 'worker_report_rejected',
  reason,
  authority: 'run_home'
})

describe('federated lifecycle settlement equality', () => {
  it('accepts exact duplicate rejection verdicts', () => {
    expect(areFederatedLifecycleSettlementsEqual(rejected('same'), rejected('same'))).toBe(true)
  })

  it.each([
    [rejected('first'), rejected('second')],
    [rejected('same'), { ...rejected('same'), code: 'different_code' }]
  ])('distinguishes rejection verdicts with different details', (left, right) => {
    expect(areFederatedLifecycleSettlementsEqual(left, right)).toBe(false)
  })

  it('distinguishes terminal outcomes', () => {
    expect(
      areFederatedLifecycleSettlementsEqual(
        { action: 'completed', authority: 'run_home' },
        { action: 'failed', authority: 'run_home' }
      )
    ).toBe(false)
  })
})
