import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, MessageType, type JsonRpcResponse } from './protocol'
import { registerRelayPtyOwnershipCaptureRequests } from './relay-pty-ownership-capture-registration'
import { PTY_OWNERSHIP_CAPTURE_METHODS as methods } from '../shared/pty-ownership-capture-wire'
import { identity } from './relay-pty-ownership-transfer-delegation-test-fixture'

const cleanups: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup())
  vi.useRealTimers()
})
function setup(authenticated = true, enabled = true) {
  const writes: Buffer[] = []
  const dispatcher = new RelayDispatcher(
    (data) => {
      writes.push(Buffer.from(data))
    },
    undefined,
    {
      principal: 'owner',
      authenticated,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential'
    }
  )
  const capture = { inspect: vi.fn(() => null), release: vi.fn() }
  const beginCapture = vi.fn(() => capture)
  const dispose = registerRelayPtyOwnershipCaptureRequests(dispatcher, { enabled, beginCapture })
  cleanups.push(() => {
    dispose()
    dispatcher.dispose()
  })
  let id = 0
  const call = async (
    method: string,
    params: Record<string, unknown>
  ): Promise<JsonRpcResponse> => {
    const requestId = ++id
    dispatcher.feed(
      encodeJsonRpcFrame({ jsonrpc: '2.0', id: requestId, method, params }, requestId, 0)
    )
    await vi.advanceTimersByTimeAsync(0)
    const responses = writes
      .filter((frame) => frame[0] === MessageType.Regular)
      .map(
        (frame) =>
          JSON.parse(
            frame.subarray(13, 13 + frame.readUInt32BE(9)).toString('utf8')
          ) as JsonRpcResponse
      )
    return responses.find((response) => response.id === requestId)!
  }
  return { dispatcher, call, beginCapture, capture }
}

it('carries capture tokens through framed requests and releases on real client detach', async () => {
  const fixture = setup()
  const params = { version: 1, ...identity, requestId: 'request-1' }
  const begun = await fixture.call(methods.begin, params)
  expect(begun.error).toBeUndefined()
  const result = begun.result as { version: number; captureToken: string }
  expect(result).toMatchObject({ version: 1, captureToken: expect.any(String) })
  expect((await fixture.call(methods.begin, params)).result).toEqual(result)
  expect(fixture.beginCapture).toHaveBeenCalledOnce()
  const token = { version: 1, captureToken: result.captureToken }
  expect((await fixture.call(methods.inspect, token)).result).toEqual({
    version: 1,
    boundary: null
  })
  fixture.dispatcher.invalidateClient('peer-closed')
  expect(fixture.capture.release).toHaveBeenCalledOnce()
})

it('refuses unauthenticated wire requests before invoking capture', async () => {
  const fixture = setup(false)
  const response = await fixture.call(methods.begin, { version: 1, ...identity, requestId: 'r' })
  expect(response.error).toBeDefined()
  expect(fixture.beginCapture).not.toHaveBeenCalled()
})

it('leaves capture methods unavailable on a runtime that has not opted in', async () => {
  const fixture = setup(true, false)
  const response = await fixture.call(methods.begin, { version: 1, ...identity, requestId: 'r' })
  expect(response.error?.code).toBe(-32601)
  expect(fixture.beginCapture).not.toHaveBeenCalled()
})

it('expires a token over the wire without keeping the capture alive on retries', async () => {
  const fixture = setup()
  const begun = await fixture.call(methods.begin, { version: 1, ...identity, requestId: 'r' })
  const result = begun.result as { captureToken: string }
  await vi.advanceTimersByTimeAsync(5_000)
  const response = await fixture.call(methods.inspect, {
    version: 1,
    captureToken: result.captureToken
  })
  expect(response.error).toBeDefined()
  expect(fixture.capture.release).toHaveBeenCalledOnce()
})
