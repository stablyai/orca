import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { MobileWebOneShotResponseDrop } from './mobile-web-one-shot-response-drop'

const CONTEXT = {
  version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
} as const

describe('MobileWebOneShotResponseDrop', () => {
  it('drops exactly one response for an observed native-chat send', () => {
    const drop = new MobileWebOneShotResponseDrop('nativeChat.sendMessage')
    drop.recordRequest(request('A', 'nativeChat', 'sendMessage'))

    expect(drop.shouldDrop(response('A'))).toBe(true)

    drop.recordRequest(request('B', 'nativeChat', 'sendMessage'))
    expect(drop.shouldDrop(response('B'))).toBe(false)
  })

  it('does not affect unrelated requests, events, or disabled builds', () => {
    const drop = new MobileWebOneShotResponseDrop('nativeChat.sendMessage')
    drop.recordRequest(request('A', 'nativeChat', 'read'))
    expect(drop.shouldDrop(response('A'))).toBe(false)

    drop.recordRequest(request('B', 'nativeChat', 'sendMessage'))
    expect(
      drop.shouldDrop({
        ...CONTEXT,
        type: 'event',
        subscriptionId: 'Q'.repeat(22),
        sequence: 1,
        payload: {}
      })
    ).toBe(false)

    const disabled = new MobileWebOneShotResponseDrop(undefined)
    disabled.recordRequest(request('C', 'nativeChat', 'sendMessage'))
    expect(disabled.shouldDrop(response('C'))).toBe(false)
  })
})

function request(
  id: string,
  capability: 'nativeChat',
  operation: string
): MobileWebBridgePageMessage {
  return {
    ...CONTEXT,
    type: 'request',
    mode: 'once',
    requestId: id.repeat(22),
    capability,
    operation,
    payload: {}
  }
}

function response(id: string): MobileWebBridgeShellMessage {
  return {
    ...CONTEXT,
    type: 'response',
    requestId: id.repeat(22),
    status: 'success',
    payload: {}
  }
}
