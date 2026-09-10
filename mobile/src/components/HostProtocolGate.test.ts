import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import { HostProtocolGate, useHostProtocolGates } from './HostProtocolGate'

const nativeTestState = vi.hoisted(() => ({
  openUrl: vi.fn(),
  replaceRoute: vi.fn(),
  platform: { OS: 'ios' as 'ios' | 'android' }
}))

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
  View: 'View'
}))

vi.mock('expo-router', () => ({
  router: { replace: nativeTestState.replaceRoute }
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

// Counts mounts so a test can prove the routes were never torn down, which presence alone can't.
const probeMounts = { count: 0 }
function MountProbe() {
  useEffect(() => {
    probeMounts.count += 1
  }, [])
  return createElement('MountProbe')
}

function gateElement() {
  return createElement(
    HostProtocolGate,
    { hostId: 'host-1' },
    createElement('HostContent', null, createElement(GateConsumer), createElement(MountProbe))
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

// The recovery card is withheld until the ladder is out, so a card assertion has to run it down.
async function exhaustStatusRetries(): Promise<void> {
  for (const delay of [1_000, 2_000, 4_000]) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(delay)
    })
  }
}

describe('HostProtocolGate', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    nativeTestState.openUrl.mockClear()
    nativeTestState.replaceRoute.mockClear()
    nativeTestState.platform.OS = 'ios'
    probeMounts.count = 0
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
    vi.useRealTimers()
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
    expect(probeMounts.count).toBe(0)
    expect(client.sendRequest).toHaveBeenCalledOnce()
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
    const overlay = renderer.root
      .findAllByType('View')
      .find((node) => node.props.accessibilityViewIsModal === true)
    expect(overlay?.props.pointerEvents).toBe('auto')
  })

  it('still replaces mounted routes when the verdict comes back blocked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain('HostContent')

    await act(async () => {
      hostClient.current = {
        client: clientWithStatus({ protocolVersion: 5, minCompatibleMobileVersion: 999 }),
        state: 'connected'
      }
      renderer?.update(gateElement())
      await Promise.resolve()
    })

    const output = renderedText(renderer)
    expect(output).toContain('Update Orca Mobile')
    expect(output).not.toContain('HostContent')
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

    const output = renderedText(renderer)
    expect(output).toContain('HostContent')
    // Why: the host already answered once, so a reconnect probe must not dim the UI it validated.
    expect(output).not.toContain('Checking host compatibility')
    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('offers recovery without mounting routes when a connected host cannot answer the status probe', async () => {
    vi.useFakeTimers()
    hostClient.current = {
      client: {
        sendRequest: vi.fn().mockResolvedValue({ ok: false, error: { message: 'unavailable' } })
      } as unknown as RpcClient,
      state: 'connected'
    }
    renderer = await renderGate()
    await exhaustStatusRetries()
    expect(renderedText(renderer)).not.toContain('HostContent')
    expect(renderedText(renderer)).toContain('Unable to verify this host')
    expect(renderedText(renderer)).toContain('Retry')
    expect(renderedText(renderer)).not.toContain('Update Orca')
  })
  it.each([
    [{ protocolVersion: 2, minCompatibleMobileVersion: 2 }, 'Update Orca on your computer'],
    [{ protocolVersion: 3, minCompatibleMobileVersion: 4 }, 'Update Orca Mobile']
  ])('blocks the published range %j at the gate', async (status, title) => {
    const physical = new FakeSession('connected')
    physical.sendRequest.mockResolvedValue({ id: '1', ok: true, result: status })
    const client = createStableLogicalRpcClient(physical, 'lan')
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain(title)
    expect(renderedText(renderer)).not.toContain('HostContent')
    expect(physical.sendRequest.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    client.close()
  })

  it('preserves mounted navigation and re-verifies across a stable-client cutover', async () => {
    const first = new FakeSession('connected')
    first.sendRequest.mockResolvedValue({
      id: '1',
      ok: true,
      result: {
        protocolVersion: 3,
        minCompatibleMobileVersion: 3
      }
    })
    const client = createStableLogicalRpcClient(first, 'lan')
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    const unsubscribe = client.subscribe('worktree.subscribe', {}, () => {})
    expect(first.subscribe).toHaveBeenCalledOnce()
    const replacement = new FakeSession('connected')
    let resolveStatus!: (value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void
    replacement.sendRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve
      })
    )
    await act(async () => {
      await client.migrateTo(replacement, 'relay')
    })
    expect(client.getGeneration()).toBe(2)
    expect(renderedText(renderer)).toContain('Checking host compatibility')
    expect(renderedText(renderer)).toContain('HostContent')
    expect(probeMounts.count).toBe(1)
    // The replay rides the cutover itself, so the stream never gaps while the gate re-verifies.
    expect(replacement.subscribe).toHaveBeenCalledOnce()
    await act(async () => {
      resolveStatus({
        id: '2',
        ok: true,
        result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
      })
    })
    expect(renderedText(renderer)).not.toContain('Checking host compatibility')
    expect(probeMounts.count).toBe(1)
    expect(replacement.sendRequest.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    unsubscribe()
    client.close()
  })

  it('keeps a resolved generation open after a transient reconnect refusal', async () => {
    const physical = new FakeSession('connected')
    physical.sendRequest.mockResolvedValue({
      id: '1',
      ok: true,
      result: {
        protocolVersion: 3,
        minCompatibleMobileVersion: 3
      }
    })
    const client = createStableLogicalRpcClient(physical, 'lan')
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    await act(async () => {
      hostClient.current = { client, state: 'disconnected' }
      renderer?.update(gateElement())
    })
    physical.sendRequest.mockResolvedValue({
      id: '2',
      ok: false,
      error: { code: 'unavailable', message: 'offline' }
    })
    await act(async () => {
      hostClient.current = { client, state: 'connected' }
      renderer?.update(gateElement())
    })
    expect(renderedText(renderer)).toContain('HostContent')
    expect(renderedText(renderer)).not.toContain('Unable to verify')
    expect(probeMounts.count).toBe(1)
    client.close()
  })

  it('bounds automatic retries and recovers after the Retry action', async () => {
    vi.useFakeTimers()
    const sendRequest = vi.fn().mockRejectedValue(new Error('offline'))
    hostClient.current = { client: { sendRequest } as unknown as RpcClient, state: 'connected' }
    renderer = await renderGate()
    for (const delay of [1000, 2000, 4000, 60000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
    }
    expect(sendRequest).toHaveBeenCalledTimes(4)
    expect(renderedText(renderer)).toContain('Unable to verify this host')
    expect(renderedText(renderer)).toContain('Back to hosts')
    act(() => renderer?.root.findAllByType('Pressable')[1].props.onPress())
    expect(nativeTestState.replaceRoute).toHaveBeenCalledWith('/')
    sendRequest.mockResolvedValue({
      ok: true,
      result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
    })
    await act(async () => {
      renderer?.root.findAllByType('Pressable')[0].props.onPress()
    })
    expect(sendRequest).toHaveBeenCalledTimes(5)
    expect(renderedText(renderer)).toContain('HostContent')
    expect(renderedText(renderer)).not.toContain('Unable to verify')
  })

  it.each([
    null,
    [],
    true,
    { protocolVersion: '3', minCompatibleMobileVersion: 3 },
    { protocolVersion: 3, minCompatibleMobileVersion: -1 }
  ])('keeps malformed status %j unknown', async (result) => {
    vi.useFakeTimers()
    hostClient.current = {
      client: {
        sendRequest: vi.fn().mockResolvedValue({ ok: true, result })
      } as unknown as RpcClient,
      state: 'connected'
    }
    renderer = await renderGate()
    await exhaustStatusRetries()
    expect(renderedText(renderer)).toContain('Unable to verify this host')
    expect(renderedText(renderer)).not.toContain('Update Orca')
    expect(renderedText(renderer)).not.toContain('HostContent')
  })

  // Why (F7): a desktop old enough to omit the fields entirely is too old, not unreadable —
  // it must get the actionable update screen, matching src/shared/protocol-compat.ts.
  it.each([{}, { appVersion: '1.0.0' }])(
    'reads a desktop that omits the protocol fields %j as too old',
    async (result) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      hostClient.current = { client: clientWithStatus(result), state: 'connected' }
      renderer = await renderGate()
      expect(renderedText(renderer)).toContain('Update Orca on your computer')
      expect(renderedText(renderer)).toContain('Open GitHub Releases')
      expect(renderedText(renderer)).not.toContain('Unable to verify')
      expect(renderedText(renderer)).not.toContain('HostContent')
    }
  )

  // Pins where the card appears: after the fourth attempt, not the second. Record existence
  // alone once counted as "already answered", which surfaced the card a second in.
  it('surfaces the recovery card only once all four attempts have failed', async () => {
    vi.useFakeTimers()
    const sendRequest = vi.fn().mockRejectedValue(new Error('timeout'))
    hostClient.current = { client: { sendRequest } as unknown as RpcClient, state: 'connected' }
    renderer = await renderGate()
    const seen: string[] = []
    const sample = () =>
      seen.push(
        `${sendRequest.mock.calls.length}:${
          renderedText(renderer as ReactTestRenderer).includes('Unable to verify this host')
            ? 'card'
            : 'spinner'
        }`
      )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    sample()
    for (const delay of [1_000, 2_000, 4_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
      sample()
    }
    expect(seen).toEqual(['1:spinner', '2:spinner', '3:spinner', '4:card'])
  })

  // Why: a cold start whose first probe fails must not flash the recovery card. main latched
  // resolved hosts so the overlay never returned; this keeps the spinner until the ladder is out.
  it('shows the spinner, not the card, while a cold start retries its first failure', async () => {
    vi.useFakeTimers()
    const session = new FakeSession('connected')
    session.sendRequest.mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({
      id: '1',
      ok: true,
      result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
    })
    const client = createStableLogicalRpcClient(session, 'lan')
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const afterFailure = renderedText(renderer)
    expect(afterFailure).toContain('Checking host compatibility')
    expect(afterFailure).not.toContain('Unable to verify this host')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(renderedText(renderer)).not.toContain('Unable to verify this host')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(renderedText(renderer)).toContain('HostContent')
    expect(session.sendRequest).toHaveBeenCalledTimes(2)
    client.close()
  })

  // Why (F3): one failed probe must not bury a live terminal under a modal it cannot
  // dismiss; the routes stay mounted and the bounded retries run behind a spinner.
  it('holds a verified host under the spinner, not the error card, while retries run', async () => {
    vi.useFakeTimers()
    const first = new FakeSession('connected')
    first.sendRequest.mockResolvedValue({
      id: '1',
      ok: true,
      result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
    })
    const client = createStableLogicalRpcClient(first, 'lan')
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(renderedText(renderer)).toContain('HostContent')

    const replacement = new FakeSession('connected')
    replacement.sendRequest.mockRejectedValue(new Error('offline'))
    await act(async () => {
      await client.migrateTo(replacement, 'relay')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const covered = renderedText(renderer)
    expect(covered).toContain('HostContent')
    expect(covered).toContain('Checking host compatibility')
    expect(covered).not.toContain('Unable to verify')
    expect(probeMounts.count).toBe(1)

    for (const delay of [1_000, 2_000, 4_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay)
      })
    }
    // Exhausted retries are a real failure, so the recovery card finally appears.
    expect(renderedText(renderer)).toContain('Unable to verify this host')
    expect(probeMounts.count).toBe(1)
    client.close()
  })

  it('cancels queued retries when the host or session changes', async () => {
    vi.useFakeTimers()
    const first = new FakeSession('connected')
    first.sendRequest.mockRejectedValue(new Error('offline'))
    const client = createStableLogicalRpcClient(first, 'lan')
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    expect(first.sendRequest).toHaveBeenCalledOnce()
    const replacement = new FakeSession('connected')
    replacement.sendRequest.mockRejectedValue(new Error('still offline'))
    await act(async () => {
      await client.migrateTo(replacement, 'relay')
    })
    expect(replacement.sendRequest).toHaveBeenCalledOnce()
    const other = clientWithStatus({ protocolVersion: 3, minCompatibleMobileVersion: 3 })
    await act(async () => {
      hostClient.current = { client: other, state: 'connected' }
      renderer?.update(
        createElement(HostProtocolGate, { hostId: 'host-2' }, createElement(MountProbe))
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(first.sendRequest).toHaveBeenCalledOnce()
    expect(replacement.sendRequest).toHaveBeenCalledOnce()
    expect(other.sendRequest).toHaveBeenCalledOnce()
    expect(renderedText(renderer)).not.toContain('Unable to verify')
    client.close()
  })
  it('ignores an old-generation success after cutover to a refusing session', async () => {
    vi.useFakeTimers()
    const first = new FakeSession('connected')
    let resolveOld!: (value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void
    first.sendRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve
      })
    )
    const client = createStableLogicalRpcClient(first, 'lan')
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    const replacement = new FakeSession('connected')
    replacement.sendRequest.mockResolvedValue({
      id: '2',
      ok: false,
      error: { code: 'unavailable', message: 'offline' }
    })
    await act(async () => {
      await client.migrateTo(replacement, 'relay')
    })
    await act(async () => {
      resolveOld({
        id: '1',
        ok: true,
        result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
      })
    })
    await exhaustStatusRetries()
    expect(renderedText(renderer)).toContain('Unable to verify this host')
    expect(renderedText(renderer)).not.toContain('HostContent')
    // Only the bounded ladder reached the replacement; the late old-generation success did not.
    expect(replacement.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'status.get',
      'status.get',
      'status.get',
      'status.get'
    ])
    client.close()
  })
})
