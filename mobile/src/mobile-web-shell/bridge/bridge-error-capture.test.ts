import { describe, expect, it } from 'vitest'
import '../../transport/rpc/rpc-delivery-ambiguity'
import './bridge-caps'
import './bridge-envelope'
import { captureBridgeError } from './bridge-error-capture'

describe('captureBridgeError', () => {
  it('still captures the rejection when a getter throws', () => {
    const throwingCode = new Error('outer')
    Object.defineProperty(throwingCode, 'code', {
      get: () => {
        throw new Error('code getter')
      },
      enumerable: true
    })
    Object.defineProperty(throwingCode, 'cause', { value: new Error('inner'), enumerable: true })
    const captured = captureBridgeError(throwingCode)
    expect('code' in captured).toBe(false)
    expect(captured.cause?.message).toBe('inner')

    const throwingCause = Object.assign(new Error('outer'), { code: 'timeout' })
    Object.defineProperty(throwingCause, 'cause', {
      get: () => {
        throw new Error('cause getter')
      },
      enumerable: true
    })
    const second = captureBridgeError(throwingCause)
    expect(second).toEqual({
      category: 'Error',
      message: 'outer',
      isRpcDeliveryUnknown: false,
      code: 'timeout'
    })
  })
})

describe('captureBridgeError budgets', () => {
  it('drops a code that cannot be serialized and keeps the rest of the error', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const error = Object.assign(new Error('outer', { cause: new Error('inner') }), { code: cyclic })
    expect(captureBridgeError(error)).toEqual({
      category: 'Error',
      message: 'outer',
      isRpcDeliveryUnknown: false,
      cause: { category: 'Error', message: 'inner', isRpcDeliveryUnknown: false }
    })
    const unserializable = Object.assign(new Error('x'), { code: () => undefined })
    expect(captureBridgeError(unserializable)).toEqual({
      category: 'Error',
      message: 'x',
      isRpcDeliveryUnknown: false
    })
  })
})
