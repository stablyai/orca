import { describe, expect, it } from 'vitest'
import type { RpcResponse } from './types'
import {
  isMethodNotFoundRefusal,
  isStreamingOpenerReply,
  requireRpcResultOrThrowCodedError,
  rpcObjectResultOrNull
} from './rpc-acceptance-policies'

const meta = { runtimeId: 'runtime-1' }

function success(result: unknown, streaming?: true): RpcResponse {
  return { id: 'rpc-1', ok: true, result, _meta: meta, ...(streaming ? { streaming } : {}) }
}

function refusal(code: string, message = 'Nope'): RpcResponse {
  return { id: 'rpc-1', ok: false, error: { code, message }, _meta: meta }
}

/** Every result partition a policy has to survive. */
const resultPartitions: [string, unknown][] = [
  ['object result', { value: 1 }],
  ['undefined result', undefined],
  ['null result', null],
  ['empty object result', {}],
  ['numeric result', 7],
  ['zero result', 0],
  ['string result', 'done'],
  ['empty string result', ''],
  ['boolean result', false],
  ['array result', [1, 2]],
  ['empty array result', []]
]

describe('requireRpcResultOrThrowCodedError', () => {
  it.each(resultPartitions)('returns the %s untouched', (_label, result) => {
    expect(requireRpcResultOrThrowCodedError(success(result))).toEqual(result)
  })

  it('returns an absent result field as undefined', () => {
    const response = { id: 'rpc-1', ok: true, _meta: meta } as unknown as RpcResponse
    expect(requireRpcResultOrThrowCodedError(response)).toBeUndefined()
  })

  it('throws a code-prefixed message on refusal', () => {
    expect(() => requireRpcResultOrThrowCodedError(refusal('method_not_found', 'no such'))).toThrow(
      'method_not_found: no such'
    )
  })

  it('throws even when the refusal carries an empty message', () => {
    expect(() => requireRpcResultOrThrowCodedError(refusal('runtime_error', ''))).toThrow(
      'runtime_error: '
    )
  })
})

describe('rpcObjectResultOrNull', () => {
  it('accepts a plain object result', () => {
    expect(rpcObjectResultOrNull(success({ value: 1 }))).toEqual({ value: 1 })
  })

  it('accepts an empty object result', () => {
    expect(rpcObjectResultOrNull(success({}))).toEqual({})
  })

  it('accepts an array result, because arrays are objects', () => {
    expect(rpcObjectResultOrNull(success([1, 2]))).toEqual([1, 2])
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['numeric', 7],
    ['zero', 0],
    ['string', 'done'],
    ['empty string', ''],
    ['boolean', false],
    ['true', true]
  ])('refuses a %s result', (_label, result) => {
    expect(rpcObjectResultOrNull(success(result))).toBeNull()
  })

  it('refuses a refusal regardless of its code', () => {
    expect(rpcObjectResultOrNull(refusal('method_not_found'))).toBeNull()
    expect(rpcObjectResultOrNull(refusal('runtime_error'))).toBeNull()
  })
})

// A refusal that illegally carries success-shaped fields: without the `ok` check each of these
// would read the stray field and answer as if the call had succeeded.
describe('a refusal carrying stray success fields', () => {
  const strayRefusal = {
    id: 'rpc-1',
    ok: false,
    error: { code: 'method_not_found', message: 'Nope' },
    result: { value: 1 },
    streaming: true,
    _meta: meta
  } as unknown as RpcResponse

  it('yields null rather than the stray result', () => {
    expect(rpcObjectResultOrNull(strayRefusal)).toBeNull()
  })

  it('is still recognised as method-not-found', () => {
    expect(isMethodNotFoundRefusal(strayRefusal)).toBe(true)
  })

  // The mirror case: a success carrying a stray error must not read as a refusal.
  it('does not read a success carrying a stray error as a refusal', () => {
    const straySuccess = {
      id: 'rpc-1',
      ok: true,
      result: { value: 1 },
      error: { code: 'method_not_found', message: 'Nope' },
      _meta: meta
    } as unknown as RpcResponse
    expect(isMethodNotFoundRefusal(straySuccess)).toBe(false)
  })
})

describe('isMethodNotFoundRefusal', () => {
  it('matches only the method_not_found code', () => {
    expect(isMethodNotFoundRefusal(refusal('method_not_found'))).toBe(true)
    expect(isMethodNotFoundRefusal(refusal('runtime_error'))).toBe(false)
    expect(isMethodNotFoundRefusal(refusal('METHOD_NOT_FOUND'))).toBe(false)
  })

  it('never matches a success, including one with a null result', () => {
    expect(isMethodNotFoundRefusal(success(null))).toBe(false)
    expect(isMethodNotFoundRefusal(success({ code: 'method_not_found' }))).toBe(false)
  })
})

describe('isStreamingOpenerReply', () => {
  it('accepts a success flagged streaming', () => {
    expect(isStreamingOpenerReply(success({ subscriptionId: 's1' }, true))).toBe(true)
  })

  it('refuses a success with no streaming flag', () => {
    expect(isStreamingOpenerReply(success({ subscriptionId: 's1' }))).toBe(false)
  })

  // A truthy non-boolean off the wire must not open a stream: the registry would route it to
  // handleStreamingResponse and wait for frames that never come.
  it.each([['yes'], [1], [{}]])('refuses a truthy non-boolean streaming flag %j', (flag) => {
    const response = {
      id: 'rpc-1',
      ok: true,
      result: { subscriptionId: 's1' },
      streaming: flag,
      _meta: meta
    } as unknown as RpcResponse
    expect(isStreamingOpenerReply(response)).toBe(false)
  })

  it('refuses a refusal even when it carries a streaming flag', () => {
    const response = {
      id: 'rpc-1',
      ok: false,
      error: { code: 'runtime_error', message: 'Nope' },
      streaming: true,
      _meta: meta
    } as unknown as RpcResponse
    expect(isStreamingOpenerReply(response)).toBe(false)
  })
})
