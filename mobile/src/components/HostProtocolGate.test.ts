import { createElement, useEffect, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { HostProtocolGate } from './HostProtocolGate'
import { useHostProtocolGates } from './host-protocol-gates-context'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

const nativeTestState = vi.hoisted(() => {
  const params: Record<string, string> = {}
  return {
    openUrl: vi.fn(),
    platform: { OS: 'ios' as 'ios' | 'android' },
    // Edit is native, so the gate holds it; page routes are covered by their own test.
    pathname: '/h/host-1/edit',
    params
  }
})

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openURL: nativeTestState.openUrl },
  Platform: nativeTestState.platform,
  Pressable: 'Pressable',
  StyleSheet: {
    create: <T>(styles: T) => styles,
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
  },
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))

vi.mock('expo-router', () => ({
  router: { replace: vi.fn() },
  // Mock native handoff’s router hook; web sibling posts target to shell.
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn(), dismissTo: vi.fn() }),
  usePathname: () => nativeTestState.pathname,
  useGlobalSearchParams: () => nativeTestState.params
}))

// Mock client acquisition only; keep real status-gates→compatibility→block-screen wiring.
const hostClient = vi.hoisted(() => ({
  current: { client: null as RpcClient | null, state: 'disconnected' as string }
}))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => hostClient.current
}))
// The wall's release offer: the native hook imports the update checker module.
vi.mock('../app-update/use-wall-app-update', () => ({ useWallAppUpdate: () => null }))
// Descriptor bookkeeping only; the real recorder reaches the native keychain through host-store.
vi.mock('../transport/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: vi.fn()
}))

function GateConsumer() {
  const { hostCapabilities } = useHostProtocolGates()
  return createElement('GateStatus', null, hostCapabilities.join(','))
}

// Counts mounts so a test can prove the routes were never torn down, which presence alone can't.
const probeMounts = { count: 0 }
function MountProbe() {
  useEffect(() => {
    probeMounts.count += 1
  }, [])
  return createElement('MountProbe')
}

function gateElement() {
  const props: ComponentProps<typeof HostProtocolGate> = {
    hostId: 'host-1',
    children: createElement(
      'HostContent',
      null,
      createElement(GateConsumer),
      createElement(MountProbe)
    )
  }
  return createElement(HostProtocolGate, props)
}

async function renderGate(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(gateElement())
    await Promise.resolve()
  })
  return renderer as unknown as ReactTestRenderer
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

describe('HostProtocolGate', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    nativeTestState.openUrl.mockClear()
    nativeTestState.platform.OS = 'ios'
    nativeTestState.pathname = '/h/host-1/edit'
    nativeTestState.params = {}
    probeMounts.count = 0
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('does not mount host routes before a connected host passes the compatibility probe', async () => {
    const client = {
      sendRequest: vi.fn().mockReturnValue(new Promise(() => {}))
    } as unknown as RpcClient
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    const output = renderedText(renderer)
    expect(output).toContain('Checking host compatibility')
    expect(output).not.toContain('HostContent')
    expect(probeMounts.count).toBe(0)
    expect(client.sendRequest).toHaveBeenCalledOnce()
  })

  it('mounts a phone page route while status is pending, with no cover', async () => {
    nativeTestState.pathname = '/h/host-1/session/wt-1'
    const client = {
      sendRequest: vi.fn().mockReturnValue(new Promise(() => {}))
    } as unknown as RpcClient
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    const output = renderedText(renderer)
    expect(output).toContain('HostContent')
    expect(output).not.toContain('Checking host compatibility')
    expect(probeMounts.count).toBe(1)
  })

  it('still holds a remote workspace page route, whose gates need the desktop status', async () => {
    nativeTestState.pathname = '/h/host-1/session/wt-1'
    nativeTestState.params = { executionHost: 'runtime:env-1' }
    const client = {
      sendRequest: vi.fn().mockReturnValue(new Promise(() => {}))
    } as unknown as RpcClient
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain('Checking host compatibility')
    expect(probeMounts.count).toBe(0)
  })

  it('overlays the pending spinner instead of unmounting routes mounted while connecting', async () => {
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain('HostContent')
    expect(probeMounts.count).toBe(1)

    const client = {
      sendRequest: vi.fn().mockReturnValue(new Promise(() => {}))
    } as unknown as RpcClient
    await act(async () => {
      hostClient.current = { client, state: 'connected' }
      renderer?.update(gateElement())
      await Promise.resolve()
    })

    const output = renderedText(renderer)
    expect(output).toContain('HostContent')
    expect(output).toContain('Checking host compatibility')
    // Why: the cold-start remount this replaces is exactly what destroys in-flight deep navigation.
    expect(probeMounts.count).toBe(1)
    const overlay = findAllByHostType(renderer.root, 'View').find(
      (node) => node.props.accessibilityViewIsModal === true
    )
    expect(overlay?.props.pointerEvents).toBe('auto')
  })
})
