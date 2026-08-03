import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { HostProtocolGate, useHostProtocolGates } from './HostProtocolGate'

const nativeTestState = vi.hoisted(() => ({
  openUrl: vi.fn(),
  platform: { OS: 'ios' as 'ios' | 'android' }
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Linking: { openURL: nativeTestState.openUrl },
  Platform: nativeTestState.platform,
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('expo-router', () => ({
  router: { replace: vi.fn() }
}))

// Why: mock only client acquisition; the gate must exercise the real
// useHostStatusGates → evaluateCompat → ProtocolBlockScreen wiring.
const hostClient = vi.hoisted(() => ({
  current: { client: null as RpcClient | null, state: 'disconnected' as string }
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => hostClient.current
}))

function clientWithStatus(result: Record<string, unknown>): RpcClient {
  return { sendRequest: vi.fn().mockResolvedValue({ ok: true, result }) } as unknown as RpcClient
}

function GateConsumer() {
  const { hostCapabilities } = useHostProtocolGates()
  return createElement('GateStatus', null, hostCapabilities.join(','))
}

function gateElement() {
  return createElement(
    HostProtocolGate,
    { hostId: 'host-1' },
    createElement('HostContent', null, createElement(GateConsumer))
  )
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
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    nativeTestState.openUrl.mockClear()
    nativeTestState.platform.OS = 'ios'
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  it('replaces the host UI with the block screen when mobile is too old', async () => {
    // Why: blocked warns to console; keep test output clean without hiding other errors.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hostClient.current = {
      client: clientWithStatus({ protocolVersion: 5, minCompatibleMobileVersion: 999 }),
      state: 'connected'
    }
    renderer = await renderGate()
    const output = renderedText(renderer)
    expect(output).toContain('Update Orca Mobile')
    expect(output).toContain('Open App Store')
    expect(output).not.toContain('HostContent')
  })

  it('routes Android mobile updates to GitHub Releases', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    nativeTestState.platform.OS = 'android'
    hostClient.current = {
      client: clientWithStatus({ protocolVersion: 5, minCompatibleMobileVersion: 999 }),
      state: 'connected'
    }
    renderer = await renderGate()
    const output = renderedText(renderer)
    expect(output).toContain('Update Orca Mobile')
    expect(output).toContain('Update Orca Mobile from GitHub Releases')
    expect(output).toContain('Open GitHub Releases')
    expect(output).not.toContain('mobile app store')
    expect(output).not.toContain('HostContent')
    act(() => renderer?.root.findAllByType('Pressable')[0]?.props.onPress())
    expect(nativeTestState.openUrl).toHaveBeenCalledWith(
      'https://github.com/stablyai/orca/releases'
    )
  })

  it('replaces the host UI with the block screen when desktop is too old', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hostClient.current = {
      client: clientWithStatus({ protocolVersion: 0, minCompatibleMobileVersion: 0 }),
      state: 'connected'
    }
    renderer = await renderGate()
    const output = renderedText(renderer)
    expect(output).toContain('Update Orca on your computer')
    expect(output).toContain('Open GitHub Releases')
    expect(output).not.toContain('HostContent')
  })

  it('renders the host UI when the verdict is ok', async () => {
    const client = clientWithStatus({
      protocolVersion: 5,
      minCompatibleMobileVersion: 0,
      capabilities: ['browser.screencast.v1']
    })
    hostClient.current = {
      client,
      state: 'connected'
    }
    renderer = await renderGate()
    const output = renderedText(renderer)
    expect(output).toContain('HostContent')
    expect(output).toContain('browser.screencast.v1')
    expect(output).not.toContain('Update Orca')
    expect(client.sendRequest).toHaveBeenCalledOnce()
  })

  it('renders the host UI while the host connection is still pending', async () => {
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain('HostContent')
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
    expect(client.sendRequest).toHaveBeenCalledOnce()
  })

  it('keeps an already-validated host route mounted while reconnect status is pending', async () => {
    const client = {
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          result: { protocolVersion: 5, minCompatibleMobileVersion: 0 }
        })
        .mockReturnValueOnce(new Promise(() => {}))
    } as unknown as RpcClient
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()

    await act(async () => {
      hostClient.current = { client, state: 'disconnected' }
      renderer?.update(gateElement())
    })
    await act(async () => {
      hostClient.current = { client, state: 'connected' }
      renderer?.update(gateElement())
      await Promise.resolve()
    })

    expect(renderedText(renderer)).toContain('HostContent')
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('fails open when a connected host cannot answer the status probe', async () => {
    hostClient.current = {
      client: {
        sendRequest: vi.fn().mockResolvedValue({ ok: false, error: { message: 'unavailable' } })
      } as unknown as RpcClient,
      state: 'connected'
    }
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain('HostContent')
  })
})
