import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MethodHandler } from './dispatcher'
import { registerRelayPtyOwnershipCaptureRequests } from './relay-pty-ownership-capture-registration'
import { PTY_OWNERSHIP_CAPTURE_METHODS as methods } from '../shared/pty-ownership-capture-wire'
import { identity, context } from './relay-pty-ownership-transfer-delegation-test-fixture'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function setup(enabled = true, selectionEnabled = false) {
  const handlers = new Map<string, MethodHandler>()
  let detach!: (id: number) => void
  const removeListener = vi.fn()
  const dispatcher = {
    onRequest: vi.fn((method: string, handler: MethodHandler) => {
      handlers.set(method, handler)
    }),
    onClientDetached: vi.fn((listener) => {
      detach = listener
      return removeListener
    })
  }
  const capture = { inspect: vi.fn(() => null), release: vi.fn() }
  const beginCapture = vi.fn(() => capture)
  const selectCaptureBaseline = vi.fn()
  const dispose = registerRelayPtyOwnershipCaptureRequests(dispatcher, {
    enabled,
    beginCapture,
    selectCaptureBaseline: selectionEnabled ? selectCaptureBaseline : undefined
  })
  const call = (method: string, params: Record<string, unknown>, client = context()) =>
    handlers.get(method)!(params, client)
  return {
    handlers,
    selectCaptureBaseline,
    dispatcher,
    removeListener,
    capture,
    beginCapture,
    dispose,
    call,
    detach: (id: number) => detach(id)
  }
}

it('registers no routes or listeners without explicit opt-in', () => {
  const fixture = setup(false)
  expect(fixture.handlers.size).toBe(0)
  expect(fixture.dispatcher.onClientDetached).not.toHaveBeenCalled()
  fixture.dispose()
})

it('gates selection separately and refuses malformed or foreign requests before selecting', async () => {
  const captureOnly = setup()
  expect(captureOnly.handlers.has(methods.select)).toBe(false)
  captureOnly.dispose()
  const fixture = setup(true, true)
  const token = (await fixture.call(methods.begin, {
    ...identity,
    version: 1,
    requestId: 'r'
  })) as Record<string, unknown>
  await expect(
    fixture.call(methods.select, { ...token, version: 2, baseline: {} })
  ).rejects.toThrow('invalid')
  await expect(
    fixture.call(methods.select, { ...token, baseline: {} }, context(99))
  ).rejects.toThrow('unavailable')
  expect(fixture.selectCaptureBaseline).not.toHaveBeenCalled()
  fixture.dispose()
  await expect(fixture.call(methods.select, { ...token, baseline: {} })).rejects.toThrow(
    'unavailable'
  )
})

it('routes exact retries and pending inspection, then revokes on disconnect', async () => {
  const fixture = setup()
  const params = { ...identity, version: 1, requestId: 'request' }
  const result = (await fixture.call(methods.begin, params)) as { captureToken: string }
  expect(await fixture.call(methods.begin, params)).toEqual(result)
  expect(fixture.beginCapture).toHaveBeenCalledOnce()
  const token = { version: 1, captureToken: result.captureToken }
  expect(await fixture.call(methods.inspect, token)).toEqual({ version: 1, boundary: null })
  await expect(fixture.call(methods.release, token, context(99))).rejects.toThrow('unavailable')
  expect(fixture.capture.release).not.toHaveBeenCalled()
  fixture.detach(context().clientId)
  expect(fixture.capture.release).toHaveBeenCalledOnce()
  await expect(fixture.call(methods.inspect, token)).rejects.toThrow('unavailable')
  fixture.dispose()
  expect(fixture.removeListener).toHaveBeenCalledOnce()
})

it('rejects malformed requests and versions before starting capture', async () => {
  const fixture = setup()
  for (const params of [
    { ...identity, version: 2, requestId: 'r' },
    { version: 1, requestId: 'r' },
    { ...identity, version: 1, requestId: '' }
  ]) {
    await expect(fixture.call(methods.begin, params)).rejects.toThrow()
  }
  await expect(fixture.call(methods.inspect, { version: 1, captureToken: 123 })).rejects.toThrow(
    'token_invalid'
  )
  expect(fixture.beginCapture).not.toHaveBeenCalled()
  fixture.dispose()
})

it('releases through RPC and refuses all further work after disposal', async () => {
  const fixture = setup()
  const params = { ...identity, version: 1, requestId: 'r' }
  const result = (await fixture.call(methods.begin, params)) as { captureToken: string }
  expect(
    await fixture.call(methods.release, { version: 1, captureToken: result.captureToken })
  ).toEqual({ version: 1, released: true })
  expect(fixture.capture.release).toHaveBeenCalledOnce()
  fixture.dispose()
  await expect(fixture.call(methods.begin, params)).rejects.toThrow('unavailable')
  expect(vi.getTimerCount()).toBe(0)
})
