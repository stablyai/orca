import { describe, expect, it } from 'vitest'
import {
  AiVaultSessionDiscoveryBudget,
  AiVaultSessionDiscoveryCapacityError
} from './session-discovery-budget'

describe('AiVaultSessionDiscoveryBudget', () => {
  it('accepts the exact path-memory capacity and rejects the next entry', () => {
    const budget = new AiVaultSessionDiscoveryBudget({ maxPathBytes: 130 })

    expect(() => budget.visitEntry('a')).not.toThrow()
    expect(() => budget.visitEntry('b')).toThrow(AiVaultSessionDiscoveryCapacityError)
  })
})
