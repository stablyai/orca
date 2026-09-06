import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../../src/shared/mobile-web/bridge-contract'
import { useMobileWebHardwareBackHandoff } from './use-mobile-web-hardware-back-handoff'
import type { MobileWebHardwareBackHandoff } from './mobile-web-hardware-back-handoff'

const backState = vi.hoisted(() => ({
  handler: null as (() => boolean) | null,
  remove: vi.fn()
}))

vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)) {
      useEffect(effect, [effect])
    }
  }
})
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  BackHandler: {
    addEventListener: vi.fn((_event, handler: () => boolean) => {
      backState.handler = handler
      return { remove: backState.remove }
    })
  }
}))

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

describe('Android hardware Back hook', () => {
  let renderer: ReactTestRenderer | null = null
  let handoff: MobileWebHardwareBackHandoff | null = null
  const postMessage = vi.fn(async (_message: MobileWebBridgeShellMessage) => {})
  const onUnhandled = vi.fn()

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    backState.handler = null
    handoff = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('falls back in the native shell while the page has not declared support', () => {
    renderProbe()

    expect(backState.handler?.()).toBe(true)
    expect(postMessage).not.toHaveBeenCalled()
    expect(onUnhandled).toHaveBeenCalledOnce()
  })

  it('forwards negotiated requests and returns unhandled results to the shell', () => {
    renderProbe()
    act(() => {
      handoff?.acknowledgeReady(CONTEXT)
      handoff?.declareSupport(capabilityMessage())
    })

    expect(backState.handler?.()).toBe(true)
    const request = postMessage.mock.calls[0]![0] as Extract<
      MobileWebBridgeShellMessage,
      { type: 'hardwareBack' }
    >
    expect(request.type).toBe('hardwareBack')
    act(() => {
      handoff?.resolve({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'hardwareBackResult',
        sequence: request.sequence,
        handled: false,
        ...CONTEXT
      })
    })
    expect(onUnhandled).toHaveBeenCalledOnce()
  })

  function renderProbe(): void {
    function Probe() {
      handoff = useMobileWebHardwareBackHandoff({
        shellSessionId: CONTEXT.shellSessionId,
        buildId: CONTEXT.buildId,
        forwardingEnabled: true,
        postMessage,
        onUnhandled
      })
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
  }
})

function capabilityMessage(): Extract<
  MobileWebBridgePageMessage,
  { type: 'hardwareBackCapability' }
> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'hardwareBackCapability',
    revision: 1,
    ...CONTEXT
  }
}
