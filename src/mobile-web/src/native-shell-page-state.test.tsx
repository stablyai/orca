// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  parseMobileWebBridgePageMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebNativeShellProvider, useMobileWebNativeShell } from './native-shell-channel'

const context = { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) }
const pageState = JSON.stringify({ version: 1, pathname: '/native-chat-settings' })
const route = { kind: 'workspaceList' as const }
const init = {
  version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  ...context,
  type: 'init',
  connection: 'connected',
  grants: [],
  resumeRoute: route
}
function dispatch(frame: object): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  })
}
afterEach(() => {
  cleanup()
  delete (window as Window & { OrcaNative?: unknown }).OrcaNative
})

describe('opaque hosted page state', () => {
  it('sends outgoing state on the first-release shell baseline', () => {
    const posted: string[] = []
    Object.assign(window, { OrcaNative: { postMessage: (raw: string) => posted.push(raw) } })
    const hook = renderHook(useMobileWebNativeShell, { wrapper: MobileWebNativeShellProvider })
    dispatch(init)
    act(() => {
      expect(hook.result.current.rememberRoute(route, pageState)).toBe(true)
    })
    const frame = JSON.parse(posted.at(-1)!)
    expect(frame.type).toBe('routeState')
    expect(frame.route).toEqual(route)
    expect(frame.pageState).toBe(pageState)
    expect(parseMobileWebBridgePageMessage(JSON.stringify(frame), context).ok).toBe(true)
  })

  it('retains page state across connection init and clears it for native navigation', () => {
    Object.assign(window, { OrcaNative: { postMessage: () => {} } })
    const hook = renderHook(useMobileWebNativeShell, { wrapper: MobileWebNativeShellProvider })
    dispatch({ ...init, pageState })
    expect(hook.result.current.pageState).toBe(pageState)
    dispatch(init)
    expect(hook.result.current.pageState).toBe(pageState)
    dispatch({
      ...context,
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'navigation',
      sequence: 1,
      route
    })
    expect(hook.result.current.pageState).toBeUndefined()
  })

  it('keeps settings during cold-resume rebinding while refreshing the legacy workspace handle', () => {
    Object.assign(window, { OrcaNative: { postMessage: () => {} } })
    const hook = renderHook(useMobileWebNativeShell, { wrapper: MobileWebNativeShellProvider })
    dispatch({ ...init, pageState })
    const rebound = {
      kind: 'session',
      workspaceId: 'new-document-handle',
      workspaceName: 'Workspace'
    }
    dispatch({
      ...context,
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'navigation',
      sequence: 1,
      route: rebound,
      pageState
    })
    expect(hook.result.current.pageState).toBe(pageState)
    expect(hook.result.current.resumeRoute).toEqual(rebound)
    expect(hook.result.current.routeRevision).toBe(2)
  })

  it('rejects oversized state and callbacks belonging to a retired document', () => {
    const posted: string[] = []
    Object.assign(window, { OrcaNative: { postMessage: (raw: string) => posted.push(raw) } })
    const hook = renderHook(useMobileWebNativeShell, { wrapper: MobileWebNativeShellProvider })
    dispatch(init)
    act(() => {
      expect(hook.result.current.rememberRoute(route, 'x'.repeat(4097))).toBe(false)
    })
    const retired = hook.result.current.rememberRoute
    dispatch({ ...init, shellSessionId: 'T'.repeat(43), buildId: 'b'.repeat(64) })
    const count = posted.length
    act(() => {
      expect(retired(route, pageState)).toBe(false)
    })
    expect(posted).toHaveLength(count)
    expect(hook.result.current.pageState).toBeUndefined()
  })

  it('rejects oversized and wrong-document routeState frames at the shell boundary', () => {
    const frame = {
      ...context,
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'routeState',
      route,
      pageState
    }
    expect(parseMobileWebBridgePageMessage(JSON.stringify(frame), context).ok).toBe(true)
    expect(
      parseMobileWebBridgePageMessage(
        JSON.stringify({ ...frame, pageState: 'x'.repeat(4097) }),
        context
      ).ok
    ).toBe(false)
    expect(
      parseMobileWebBridgePageMessage(
        JSON.stringify({ ...frame, shellSessionId: 'T'.repeat(43) }),
        context
      ).ok
    ).toBe(false)
  })
})
