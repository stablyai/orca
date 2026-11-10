import { describe, expect, it } from 'vitest'
import { normalizeSparsePresetDirectories } from './sparse-preset-validation'
import { mapRuntimeError } from '../../runtime/rpc/errors'

describe('sparse preset validation transport', () => {
  it('keeps the validation reason in the RPC envelope', () => {
    let failure: unknown
    try {
      normalizeSparsePresetDirectories(['../outside'])
    } catch (error) {
      failure = error
    }
    expect(mapRuntimeError('request', { runtimeId: 'runtime' }, failure).error).toMatchObject({
      code: 'runtime_error',
      data: {
        errorCode: 'directories_invalid'
      }
    })
  })
})
