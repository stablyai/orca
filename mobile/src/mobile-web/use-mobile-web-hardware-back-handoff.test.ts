import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgeMessageContext,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebHardwareBackHandoff } from './mobile-web-hardware-back-handoff'

const CONTEXT: MobileWebBridgeMessageContext = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const OTHER_CONTEXT: MobileWebBridgeMessageContext = {
  shellSessionId: 'T'.repeat(43),
  buildId: 'b'.repeat(64)
}

afterEach(() => vi.useRealTimers())

describe('mobile web hardware Back handoff', () => {
  it('keeps an old page on the native-shell fallback without sending an unknown message', () => {
    const handoff = readyHandoff()
    const postMessage = vi.fn(async (_message: MobileWebBridgeShellMessage) => {})

    expect(handoff.request(postMessage, vi.fn())).toBe(false)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('forwards only after the loaded page declares support and accepts a handled result', () => {
    const handoff = supportedHandoff()
    const postMessage = vi.fn(async (_message: MobileWebBridgeShellMessage) => {})
    const onUnhandled = vi.fn()

    expect(handoff.request(postMessage, onUnhandled)).toBe(true)
    const request = postMessage.mock.calls[0]![0] as Extract<
      MobileWebBridgeShellMessage,
      { type: 'hardwareBack' }
    >
    expect(request).toMatchObject({ type: 'hardwareBack', sequence: 1, ...CONTEXT })
    expect(handoff.resolve(resultMessage(request.sequence, true))).toBe(true)
    expect(onUnhandled).not.toHaveBeenCalled()
  })

  it('returns an unhandled page result to the native shell exactly once', () => {
    const handoff = supportedHandoff()
    const postMessage = vi.fn(async (_message: MobileWebBridgeShellMessage) => {})
    const onUnhandled = vi.fn()
    handoff.request(postMessage, onUnhandled)
    const request = postMessage.mock.calls[0]![0] as Extract<
      MobileWebBridgeShellMessage,
      { type: 'hardwareBack' }
    >

    expect(handoff.resolve(resultMessage(request.sequence, false))).toBe(true)
    expect(handoff.resolve(resultMessage(request.sequence, false))).toBe(false)
    expect(onUnhandled).toHaveBeenCalledOnce()
  })

  it('correlates every physical Back press while earlier results are pending', () => {
    const handoff = supportedHandoff()
    const postMessage = vi.fn(async (_message: MobileWebBridgeShellMessage) => {})
    const onUnhandled = vi.fn()

    expect(handoff.request(postMessage, onUnhandled)).toBe(true)
    expect(handoff.request(postMessage, onUnhandled)).toBe(true)
    const requests = postMessage.mock.calls.map(
      ([message]) => message as Extract<MobileWebBridgeShellMessage, { type: 'hardwareBack' }>
    )
    expect(requests.map(({ sequence }) => sequence)).toEqual([1, 2])

    expect(handoff.resolve(resultMessage(2, true))).toBe(true)
    expect(handoff.resolve(resultMessage(1, true))).toBe(true)
    expect(onUnhandled).not.toHaveBeenCalled()
  })

  it('falls back on timeout and ignores a late result', () => {
    vi.useFakeTimers()
    const handoff = supportedHandoff(50)
    const postMessage = vi.fn(async (_message: MobileWebBridgeShellMessage) => {})
    const onUnhandled = vi.fn()
    handoff.request(postMessage, onUnhandled)
    const request = postMessage.mock.calls[0]![0] as Extract<
      MobileWebBridgeShellMessage,
      { type: 'hardwareBack' }
    >

    vi.advanceTimersByTime(50)
    expect(onUnhandled).toHaveBeenCalledOnce()
    expect(handoff.resolve(resultMessage(request.sequence, true))).toBe(false)
    expect(onUnhandled).toHaveBeenCalledOnce()
  })

  it('cancels pending work and rejects stale declarations across page lifecycles', () => {
    vi.useFakeTimers()
    const handoff = supportedHandoff(50)
    const postMessage = vi.fn(async (_message: MobileWebBridgeShellMessage) => {})
    const onUnhandled = vi.fn()
    handoff.request(postMessage, onUnhandled)

    handoff.setContext(OTHER_CONTEXT)
    vi.advanceTimersByTime(50)
    expect(onUnhandled).not.toHaveBeenCalled()
    handoff.declareSupport(capabilityMessage(CONTEXT))
    handoff.acknowledgeReady(OTHER_CONTEXT)
    expect(handoff.request(postMessage, onUnhandled)).toBe(false)
  })

  it('requires ready before accepting a capability declaration', () => {
    const handoff = new MobileWebHardwareBackHandoff()
    const postMessage = vi.fn(async (_message: MobileWebBridgeShellMessage) => {})
    handoff.setContext(CONTEXT)
    handoff.declareSupport(capabilityMessage(CONTEXT))

    expect(handoff.request(postMessage, vi.fn())).toBe(false)
  })
})

function readyHandoff(timeoutMs?: number): MobileWebHardwareBackHandoff {
  const handoff = new MobileWebHardwareBackHandoff(timeoutMs)
  handoff.setContext(CONTEXT)
  handoff.acknowledgeReady(CONTEXT)
  return handoff
}

function supportedHandoff(timeoutMs?: number): MobileWebHardwareBackHandoff {
  const handoff = readyHandoff(timeoutMs)
  handoff.declareSupport(capabilityMessage(CONTEXT))
  return handoff
}

function capabilityMessage(
  context: MobileWebBridgeMessageContext
): Extract<MobileWebBridgePageMessage, { type: 'hardwareBackCapability' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'hardwareBackCapability',
    revision: 1,
    ...context
  }
}

function resultMessage(
  sequence: number,
  handled: boolean
): Extract<MobileWebBridgePageMessage, { type: 'hardwareBackResult' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'hardwareBackResult',
    sequence,
    handled,
    ...CONTEXT
  }
}
