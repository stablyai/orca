import { describe, expect, it } from 'vitest'
import { classifyRexRpcRejection, RexSessionCapacityError } from './rex-rpc-rejection'

describe('Rex capacity no-create proof', () => {
  it('only classifies the exact atomic create capacity response, never ambiguous or unrelated refusals', () => {
    const capacity = {
      code: 'conflict',
      status: 409,
      message: 'server already has its maximum of 64 sessions; destroy one before creating another'
    }
    expect(classifyRexRpcRejection('session.create', capacity)).toBeInstanceOf(
      RexSessionCapacityError
    )
    for (const response of [
      null,
      'conflict',
      { ...capacity, status: 500 },
      { ...capacity, message: 'another conflict' },
      { ...capacity, code: 'unknown' }
    ]) {
      expect(classifyRexRpcRejection('session.create', response)).not.toBeInstanceOf(
        RexSessionCapacityError
      )
    }
    expect(classifyRexRpcRejection('block.close', capacity)).not.toBeInstanceOf(
      RexSessionCapacityError
    )
  })
})
