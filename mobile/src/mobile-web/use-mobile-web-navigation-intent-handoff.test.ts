import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebResumeRoute
} from '../../../src/shared/mobile-web/bridge-contract'
import type { HostProfile } from '../transport/types'
import type { MobileWebCapabilityBroker } from './mobile-web-capability-broker'
import { MOBILE_WEB_NAVIGATION_INTENTS } from './mobile-web-navigation-intent-buffer'
import { useMobileWebNavigationIntentHandoff } from './use-mobile-web-navigation-intent-handoff'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.restoreAllMocks()
})

describe('useMobileWebNavigationIntentHandoff', () => {
  it('suppresses a delayed destination after a newer native intent supersedes it', async () => {
    const first = deferred<MobileWebResumeRoute>()
    const second = deferred<MobileWebResumeRoute>()
    const resolveNavigationRoute = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const broker = { resolveNavigationRoute } as unknown as MobileWebCapabilityBroker
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const rememberRoute = vi.fn()
    const onNavigationResolved = vi.fn()
    const options = {
      hosts: [{ id: 'paired-host' }] as HostProfile[],
      hostsLoading: false,
      selectedHostId: 'paired-host',
      connectionState: 'connected' as const,
      shellContext: { sessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) },
      pageReadySessionId: 'S'.repeat(43),
      brokerSessionId: 'S'.repeat(43),
      getBroker: () => broker,
      selectHost: vi.fn(),
      refreshHosts: vi.fn().mockResolvedValue(undefined),
      postMessage,
      rememberRoute,
      onNavigationResolved,
      showWarning: vi.fn()
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => {
      renderer = create(createElement(NavigationIntentHarness, { options }))
    })
    consoleError.mockRestore()

    let firstIntent
    let secondIntent
    act(() => {
      firstIntent = MOBILE_WEB_NAVIGATION_INTENTS.publish({
        kind: 'session',
        hostId: 'paired-host',
        hostWorkspaceId: 'host-workspace-one'
      })
    })
    act(() => {
      secondIntent = MOBILE_WEB_NAVIGATION_INTENTS.publish({
        kind: 'session',
        hostId: 'paired-host',
        hostWorkspaceId: 'host-workspace-two'
      })
    })
    expect(resolveNavigationRoute).toHaveBeenNthCalledWith(1, 'host-workspace-one')
    expect(resolveNavigationRoute).toHaveBeenNthCalledWith(2, 'host-workspace-two')

    await act(async () => {
      first.resolve({
        kind: 'session',
        workspaceId: 'stale-opaque-workspace',
        workspaceName: 'Stale'
      })
      await Promise.resolve()
    })
    expect(postMessage).not.toHaveBeenCalled()

    await act(async () => {
      second.resolve({
        kind: 'session',
        workspaceId: 'current-opaque-workspace',
        workspaceName: 'Current'
      })
      await Promise.resolve()
    })
    expect(rememberRoute).toHaveBeenCalledWith({
      kind: 'session',
      workspaceId: 'current-opaque-workspace',
      workspaceName: 'Current'
    })
    expect(postMessage).toHaveBeenCalledWith({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'navigation',
      shellSessionId: 'S'.repeat(43),
      buildId: 'a'.repeat(64),
      sequence: secondIntent!.sequence,
      route: {
        kind: 'session',
        workspaceId: 'current-opaque-workspace',
        workspaceName: 'Current'
      }
    })
    expect(onNavigationResolved).toHaveBeenCalledWith(secondIntent, {
      kind: 'session',
      workspaceId: 'current-opaque-workspace',
      workspaceName: 'Current'
    })
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('host-workspace')
    expect(MOBILE_WEB_NAVIGATION_INTENTS.isCurrent(firstIntent!.sequence)).toBe(false)
    expect(MOBILE_WEB_NAVIGATION_INTENTS.isCurrent(secondIntent!.sequence)).toBe(false)
  })

  it('routes a typed Home destination without resolving a host workspace id', async () => {
    const broker = {
      resolveNavigationRoute: vi.fn()
    } as unknown as MobileWebCapabilityBroker
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const options = {
      hosts: [{ id: 'paired-host' }] as HostProfile[],
      hostsLoading: false,
      selectedHostId: 'paired-host',
      connectionState: 'connected' as const,
      shellContext: { sessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) },
      pageReadySessionId: 'S'.repeat(43),
      brokerSessionId: 'S'.repeat(43),
      getBroker: () => broker,
      selectHost: vi.fn(),
      refreshHosts: vi.fn().mockResolvedValue(undefined),
      postMessage,
      rememberRoute: vi.fn(),
      onNavigationResolved: vi.fn(),
      showWarning: vi.fn()
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => {
      renderer = create(createElement(NavigationIntentHarness, { options }))
    })
    consoleError.mockRestore()

    let intent
    await act(async () => {
      intent = MOBILE_WEB_NAVIGATION_INTENTS.publishHostTarget('paired-host', {
        kind: 'newWorkspace'
      })
      await Promise.resolve()
    })

    expect(broker.resolveNavigationRoute).not.toHaveBeenCalled()
    expect(options.rememberRoute).not.toHaveBeenCalled()
    expect(options.onNavigationResolved).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith({
      version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      type: 'navigation',
      shellSessionId: 'S'.repeat(43),
      buildId: 'a'.repeat(64),
      sequence: intent!.sequence,
      route: { kind: 'newWorkspace' }
    })
  })
})

function NavigationIntentHarness({
  options
}: {
  options: Parameters<typeof useMobileWebNavigationIntentHandoff>[0]
}) {
  useMobileWebNavigationIntentHandoff(options)
  return null
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
