// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebNativeShellProvider, useMobileWebNativeShell } from './native-shell-channel'
import { installMobileWebHardwareBackHandler } from './mobile-web-hardware-back-handler'
import {
  MOBILE_WEB_SHELL_LISTENING_PROPERTY,
  MOBILE_WEB_SHELL_PENDING_PROPERTY
} from './native-shell-message-inbox'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}

type NativeTestWindow = Window & {
  OrcaNative?: Readonly<{ postMessage(value: string): void }>
  [MOBILE_WEB_SHELL_LISTENING_PROPERTY]?: boolean
  [MOBILE_WEB_SHELL_PENDING_PROPERTY]?: string[]
}

beforeEach(() => {
  const target = window as NativeTestWindow
  delete target[MOBILE_WEB_SHELL_LISTENING_PROPERTY]
  delete target[MOBILE_WEB_SHELL_PENDING_PROPERTY]
  delete target.OrcaNative
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('mobile web native shell channel', () => {
  it('owns one client per session, routes responses, and disposes pending requests', async () => {
    const posted: MobileWebBridgePageMessage[] = []
    const target = window as NativeTestWindow
    target.OrcaNative = {
      postMessage: (raw) => {
        posted.push(JSON.parse(raw) as MobileWebBridgePageMessage)
      }
    }
    const hook = renderHook(() => useMobileWebNativeShell(), {
      wrapper: MobileWebNativeShellProvider
    })

    act(() =>
      dispatchShellMessage({
        ...initMessage(),
        resumeRoute: {
          kind: 'session',
          workspaceId: 'opaque-workspace',
          workspaceName: 'Feature'
        }
      })
    )
    const client = hook.result.current.client
    expect(client).not.toBeNull()
    expect(hook.result.current.context).toEqual(CONTEXT)
    expect(hook.result.current.connection).toBe('connected')
    expect(hook.result.current.hostDisplayName).toBe('Host 1')
    expect(hook.result.current.routeRevision).toBe(1)
    expect(hook.result.current.resumeRoute).toEqual({
      kind: 'session',
      workspaceId: 'opaque-workspace',
      workspaceName: 'Feature'
    })
    expect(hook.result.current.navigationRoute).toEqual(hook.result.current.resumeRoute)
    expect(posted).toContainEqual({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'ready',
      ...CONTEXT
    })
    act(() => {
      expect(hook.result.current.rememberRoute({ kind: 'workspaceList' })).toBe(true)
    })
    expect(hook.result.current.resumeRoute).toEqual({ kind: 'workspaceList' })
    expect(hook.result.current.navigationRoute).toEqual({ kind: 'workspaceList' })
    expect(hook.result.current.routeRevision).toBe(1)
    expect(posted).toContainEqual({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'routeState',
      route: { kind: 'workspaceList' },
      ...CONTEXT
    })

    act(() => dispatchShellMessage(initMessage()))
    expect(hook.result.current.client).toBe(client)
    expect(hook.result.current.resumeRoute).toEqual({ kind: 'workspaceList' })
    expect(hook.result.current.routeRevision).toBe(1)
    expect(posted.filter((message) => message.type === 'ready')).toHaveLength(2)

    act(() =>
      dispatchShellMessage(
        navigationMessage(2, {
          kind: 'session',
          workspaceId: 'notification-target',
          workspaceName: 'Notification target'
        })
      )
    )
    expect(hook.result.current.navigationRoute).toEqual({
      kind: 'session',
      workspaceId: 'notification-target',
      workspaceName: 'Notification target'
    })
    expect(hook.result.current.resumeRoute).toEqual({ kind: 'workspaceList' })
    expect(hook.result.current.routeRevision).toBe(2)

    act(() => dispatchShellMessage(navigationMessage(2, { kind: 'workspaceList' })))
    act(() => dispatchShellMessage(navigationMessage(1, { kind: 'workspaceList' })))
    expect(hook.result.current.navigationRoute).toEqual({
      kind: 'session',
      workspaceId: 'notification-target',
      workspaceName: 'Notification target'
    })
    expect(hook.result.current.routeRevision).toBe(2)

    act(() =>
      dispatchShellMessage({
        ...navigationMessage(3, { kind: 'workspaceList' }),
        shellSessionId: 'T'.repeat(43)
      })
    )
    act(() =>
      dispatchShellMessage({
        ...navigationMessage(4, { kind: 'workspaceList' }),
        buildId: 'b'.repeat(64)
      })
    )
    expect(hook.result.current.routeRevision).toBe(2)

    const snapshot = client?.workspaceSnapshot({ limit: 10 })
    const request = posted.find(
      (message): message is Extract<MobileWebBridgePageMessage, { type: 'request' }> =>
        message.type === 'request'
    )
    expect(request).toBeDefined()
    act(() =>
      dispatchShellMessage({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'response',
        ...CONTEXT,
        requestId: request?.requestId ?? '',
        status: 'success',
        payload: { workspaces: [], truncated: false }
      })
    )
    await expect(snapshot).resolves.toEqual({ workspaces: [], truncated: false })

    const pending = client?.workspaceSnapshot({ limit: 10 })
    const pendingExpectation = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    hook.unmount()
    await pendingExpectation
    expect(posted.at(-1)).toMatchObject({ type: 'cancel', target: 'request' })
  })

  it('opens its default route when a newer shell resumes a route kind it cannot name', () => {
    const target = window as NativeTestWindow
    target.OrcaNative = { postMessage: () => {} }
    const hook = renderHook(() => useMobileWebNativeShell(), {
      wrapper: MobileWebNativeShellProvider
    })

    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            ...initMessage(),
            resumeRoute: { kind: 'someFutureKind', workspaceId: 'opaque-workspace' }
          })
        })
      )
    )

    // Why: dropping the init instead would cost the page every grant, not one route.
    expect(hook.result.current.client).not.toBeNull()
    expect(hook.result.current.resumeRoute).toEqual({ kind: 'workspaceList' })
    expect(hook.result.current.navigationRoute).toEqual({ kind: 'workspaceList' })
  })

  it('retires pending work when the shell session or build changes', async () => {
    const posted: MobileWebBridgePageMessage[] = []
    const target = window as NativeTestWindow
    target.OrcaNative = {
      postMessage: (raw) => {
        posted.push(JSON.parse(raw) as MobileWebBridgePageMessage)
      }
    }
    const hook = renderHook(() => useMobileWebNativeShell(), {
      wrapper: MobileWebNativeShellProvider
    })
    act(() => dispatchShellMessage(initMessage()))
    const previousClient = hook.result.current.client!
    const previous = previousClient.workspaceSnapshot({ limit: 10 })
    const previousExpectation = expect(previous).rejects.toMatchObject({ code: 'cancelled' })
    const previousRequest = posted.find(
      (message): message is Extract<MobileWebBridgePageMessage, { type: 'request' }> =>
        message.type === 'request'
    )!
    const nextContext = {
      shellSessionId: 'T'.repeat(43),
      buildId: 'b'.repeat(64)
    }

    act(() => dispatchShellMessage(initMessage(nextContext)))
    await previousExpectation
    expect(hook.result.current.context).toEqual(nextContext)
    expect(hook.result.current.client).not.toBe(previousClient)

    act(() =>
      dispatchShellMessage({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'response',
        ...CONTEXT,
        requestId: previousRequest.requestId,
        status: 'success',
        payload: { workspaces: [], truncated: false }
      })
    )
    const current = hook.result.current.client!.workspaceSnapshot({ limit: 10 })
    const currentRequest = posted.findLast(
      (message): message is Extract<MobileWebBridgePageMessage, { type: 'request' }> =>
        message.type === 'request'
    )!
    act(() =>
      dispatchShellMessage({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'response',
        ...nextContext,
        requestId: currentRequest.requestId,
        status: 'success',
        payload: { workspaces: [], truncated: false }
      })
    )
    await expect(current).resolves.toEqual({ workspaces: [], truncated: false })
  })

  it('declares Back support after ready and correlates handled requests', () => {
    const posted: MobileWebBridgePageMessage[] = []
    const handler = vi.fn(() => true)
    const uninstall = installMobileWebHardwareBackHandler(handler)
    const target = window as NativeTestWindow
    target.OrcaNative = {
      postMessage: (raw) => posted.push(JSON.parse(raw) as MobileWebBridgePageMessage)
    }
    const hook = renderHook(() => useMobileWebNativeShell(), {
      wrapper: MobileWebNativeShellProvider
    })

    act(() => dispatchShellMessage(initMessage()))
    expect(posted.slice(0, 2)).toEqual([
      { version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION, type: 'ready', ...CONTEXT },
      {
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'hardwareBackCapability',
        revision: 1,
        ...CONTEXT
      }
    ])
    act(() =>
      dispatchShellMessage({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        type: 'hardwareBack',
        sequence: 7,
        ...CONTEXT
      })
    )
    expect(handler).toHaveBeenCalledOnce()
    expect(posted.at(-1)).toEqual({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'hardwareBackResult',
      sequence: 7,
      handled: true,
      ...CONTEXT
    })

    hook.unmount()
    uninstall()
  })
})

function initMessage(
  context: typeof CONTEXT = CONTEXT
): Extract<MobileWebBridgeShellMessage, { type: 'init' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'init',
    ...context,
    connection: 'connected',
    hostDisplayName: 'Host 1',
    grants: [
      {
        capability: 'workspace',
        operation: 'snapshot',
        limits: {
          maxRequestBytes: 1024,
          maxResponseBytes: 128 * 1024,
          maxConcurrent: 2,
          rateCapacity: 4,
          rateRefillPerSecond: 1
        }
      }
    ]
  }
}

function navigationMessage(
  sequence: number,
  route: Extract<MobileWebBridgeShellMessage, { type: 'navigation' }>['route']
): Extract<MobileWebBridgeShellMessage, { type: 'navigation' }> {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'navigation',
    ...CONTEXT,
    sequence,
    route
  }
}

function dispatchShellMessage(message: MobileWebBridgeShellMessage): void {
  window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
}
