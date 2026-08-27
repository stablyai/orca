import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from './index'

describe('mission RPC manifest', () => {
  it('registers mission.plan exactly once', () => {
    expect(ALL_RPC_METHODS.filter((method) => method.name === 'mission.plan')).toHaveLength(1)
  })
})
