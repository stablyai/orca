import { describe, expect, it } from 'vitest'
import {
  isRpcDeliveryUnknown,
  markRpcDeliveryUnknown
} from '../../transport/rpc-delivery-ambiguity'
import {
  BRIDGE_MAX_CAUSE_DEPTH,
  BRIDGE_UNREADABLE_ERROR_MESSAGE,
  BridgeErrorCaptureSchema,
  captureBridgeError,
  reconstructBridgeError,
  type BridgeErrorCapture
} from './bridge-error-capture'

class RpcTimeoutError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

/** What the wire actually does to a capture, so nothing in these tests is proved in memory. */
function overTheWire(capture: BridgeErrorCapture): BridgeErrorCapture {
  const parsed = BridgeErrorCaptureSchema.safeParse(JSON.parse(JSON.stringify(capture)))
  if (!parsed.success) {
    throw new Error(`capture did not survive its own schema: ${parsed.error.message}`)
  }
  return parsed.data
}

function causeChain(depth: number): Error {
  let error = new Error('root')
  for (let level = depth; level > 0; level -= 1) {
    error = new Error(`level-${level}`, { cause: error })
  }
  return error
}

describe('captureBridgeError', () => {
  it('captures three fields for an error carrying nothing else', () => {
    const capture = captureBridgeError(new Error('boom'))
    expect(capture).toEqual({ category: 'Error', message: 'boom', isRpcDeliveryUnknown: false })
    expect(Object.keys(capture).sort()).toEqual(['category', 'isRpcDeliveryUnknown', 'message'])
  })

  it('never carries a stack', () => {
    expect(JSON.stringify(captureBridgeError(new Error('boom')))).not.toContain('stack')
  })

  it('keeps the subclass name, which is what the recorder reads', () => {
    expect(captureBridgeError(new RpcTimeoutError('late', 'timeout')).category).toBe(
      'RpcTimeoutError'
    )
  })

  it('keeps a string code and a numeric code', () => {
    expect(captureBridgeError(new RpcTimeoutError('late', 'timeout')).code).toBe('timeout')
    const numbered = Object.assign(new Error('closed'), { code: 1006 })
    expect(captureBridgeError(numbered).code).toBe(1006)
  })

  it('keeps a code the transport does not narrow, so the recorder sees the same field', () => {
    const structured = Object.assign(new Error('closed'), { code: { status: 500 } })
    expect(captureBridgeError(structured).code).toEqual({ status: 500 })
  })

  it('keeps an absent code absent rather than sending an undefined one', () => {
    expect('code' in captureBridgeError(new Error('bare'))).toBe(false)
    expect('code' in captureBridgeError(Object.assign(new Error('x'), { code: undefined }))).toBe(
      false
    )
  })

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

  it('captures something for an error whose message getter throws', () => {
    const error = new Error('outer')
    Object.defineProperty(error, 'message', {
      get: () => {
        throw new Error('message getter')
      }
    })
    markRpcDeliveryUnknown(error)
    expect(captureBridgeError(error)).toEqual({
      category: 'Error',
      message: BRIDGE_UNREADABLE_ERROR_MESSAGE,
      isRpcDeliveryUnknown: true
    })
  })

  it('captures something for a thrown value whose toString throws', () => {
    const thrown = {
      toString: () => {
        throw new Error('toString')
      }
    }
    expect(captureBridgeError(thrown)).toEqual({
      category: 'Error',
      message: BRIDGE_UNREADABLE_ERROR_MESSAGE,
      isRpcDeliveryUnknown: false
    })
  })

  it('captures something when the cause chain throws partway down', () => {
    const inner = new Error('inner')
    Object.defineProperty(inner, 'message', {
      get: () => {
        throw new Error('message getter')
      }
    })
    const outer = new Error('outer', { cause: inner })
    expect(captureBridgeError(outer).cause).toEqual({
      category: 'Error',
      message: BRIDGE_UNREADABLE_ERROR_MESSAGE,
      isRpcDeliveryUnknown: false
    })
  })

  it('reads a code defined as a getter', () => {
    const error = new Error('closed')
    Object.defineProperty(error, 'code', { get: () => 'from-getter', enumerable: true })
    expect(captureBridgeError(error).code).toBe('from-getter')
  })

  it('describes a thrown value that is not an error', () => {
    expect(captureBridgeError('nope')).toEqual({
      category: 'string',
      message: 'nope',
      isRpcDeliveryUnknown: false
    })
  })

  it('follows the cause chain exactly as deep as the recorder does', () => {
    const capture = captureBridgeError(causeChain(BRIDGE_MAX_CAUSE_DEPTH + 2))
    let level = 0
    let node: BridgeErrorCapture | undefined = capture.cause
    while (node !== undefined) {
      level += 1
      node = node.cause
    }
    expect(level).toBe(BRIDGE_MAX_CAUSE_DEPTH)
  })

  it('captures a cause that is not an error', () => {
    expect(captureBridgeError(new Error('outer', { cause: 42 })).cause).toEqual({
      category: 'number',
      message: '42',
      isRpcDeliveryUnknown: false
    })
  })
})

describe('BridgeErrorCaptureSchema', () => {
  it('accepts a chain of exactly the cause depth', () => {
    expect(BridgeErrorCaptureSchema.safeParse(captureBridgeError(causeChain(20))).success).toBe(
      true
    )
  })

  it('truncates a chain deeper than the capture can produce rather than losing the error', () => {
    const deepest = captureBridgeError(causeChain(20))
    let node: BridgeErrorCapture = deepest
    let depth = 0
    while (node.cause !== undefined) {
      node = node.cause
      depth += 1
    }
    node.cause = { category: 'Error', message: 'too deep', isRpcDeliveryUnknown: false }
    const parsed = BridgeErrorCaptureSchema.safeParse(deepest)
    expect(depth).toBe(BRIDGE_MAX_CAUSE_DEPTH)
    expect(parsed.success && parsed.data.cause?.cause?.cause?.cause?.cause).toBeUndefined()
    expect(parsed.success && parsed.data.cause?.cause?.cause?.cause?.message).toBe('level-5')
  })
})

describe('reconstructBridgeError', () => {
  it('re-applies the delivery-unknown mark, which cannot survive serialization', () => {
    const original = markRpcDeliveryUnknown(new Error('socket closed mid-request'))
    expect(isRpcDeliveryUnknown(original)).toBe(true)

    const capture = overTheWire(captureBridgeError(original))
    expect(isRpcDeliveryUnknown(capture)).toBe(false)

    const rebuilt = reconstructBridgeError(capture)
    expect(isRpcDeliveryUnknown(rebuilt)).toBe(true)
    expect(rebuilt.message).toBe('socket closed mid-request')
  })

  it('leaves an unmarked error unmarked', () => {
    const rebuilt = reconstructBridgeError(overTheWire(captureBridgeError(new Error('plain'))))
    expect(isRpcDeliveryUnknown(rebuilt)).toBe(false)
  })

  it('reports the same constructor name, so a recorded rejection does not move', () => {
    const original = new RpcTimeoutError('late', 'timeout')
    const rebuilt = reconstructBridgeError(overTheWire(captureBridgeError(original)))
    expect(rebuilt.constructor.name).toBe('RpcTimeoutError')
    expect(rebuilt.name).toBe('RpcTimeoutError')
    expect(rebuilt).toBeInstanceOf(Error)
  })

  it('round-trips to the same capture the host made', () => {
    const original = markRpcDeliveryUnknown(new RpcTimeoutError('late', 'timeout'))
    const captured = overTheWire(captureBridgeError(original))
    expect(captureBridgeError(reconstructBridgeError(captured))).toEqual(captured)
  })

  it('rebuilds the cause chain as errors, not as plain data', () => {
    const original = new Error('outer', { cause: new RpcTimeoutError('inner', 'timeout') })
    const rebuilt = reconstructBridgeError(overTheWire(captureBridgeError(original)))
    expect(rebuilt.cause).toBeInstanceOf(Error)
    expect(rebuilt.cause).toMatchObject({ message: 'inner', code: 'timeout' })
  })

  it('reuses one class per category rather than minting one per error', () => {
    const first = reconstructBridgeError({
      category: 'RpcTimeoutError',
      message: 'a',
      isRpcDeliveryUnknown: false
    })
    const second = reconstructBridgeError({
      category: 'RpcTimeoutError',
      message: 'b',
      isRpcDeliveryUnknown: false
    })
    expect(first.constructor).toBe(second.constructor)
  })

  it('still names a category it has never seen before', () => {
    const rebuilt = reconstructBridgeError({
      category: `Novel${Math.random().toString(36).slice(2, 8)}Error`,
      message: 'x',
      isRpcDeliveryUnknown: true
    })
    expect(rebuilt.constructor.name).toBe(rebuilt.name)
    expect(isRpcDeliveryUnknown(rebuilt)).toBe(true)
  })
})
