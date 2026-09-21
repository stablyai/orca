import { describe, expect, it } from 'vitest'
import {
  RPC_PARAMS_BY_METHOD,
  RPC_METHODS_WITHOUT_SHARED_PARAMS
} from '../../shared/rpc-contract/rpc-params-catalog.generated'

describe('personal Linear Inbox transport boundary', () => {
  it('does not publish notification reads or mutations to paired clients or CLI', () => {
    const methods = [
      ...Object.keys(RPC_PARAMS_BY_METHOD),
      ...RPC_METHODS_WITHOUT_SHARED_PARAMS
    ].filter((name) => name.startsWith('linear.'))
    expect(methods.length).toBeGreaterThan(0)
    expect(methods.filter((name) => /inbox|notification/i.test(name))).toEqual([])
  })
})
