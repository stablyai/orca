import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostProtocolAdmission } from '../transport/host-protocol-admission'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { attachHostProtocolVerification } from '../transport/host-protocol-verifier'
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

// Verification belongs to the client, so every gate fixture is a real logical client.
function verifiedClient(session: FakeSession): RpcClient {
  return attachHostProtocolVerification(
    createStableLogicalRpcClient(session, 'lan', new HostProtocolAdmission()),
    'host-1'
  )
}

function sessionWithStatus(result: unknown): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockResolvedValue({ id: '1', ok: true, result })
  return session
}

function clientWithStatus(result: Record<string, unknown>): RpcClient {
  return verifiedClient(sessionWithStatus(result))
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
    const session = sessionWithStatus({
      protocolVersion: 5,
      minCompatibleMobileVersion: 0,
      capabilities: ['browser.screencast.v1']
    })
    hostClient.current = { client: verifiedClient(session), state: 'connected' }
    renderer = await renderGate()
    const output = renderedText(renderer)
    expect(output).toContain('HostContent')
    expect(output).toContain('browser.screencast.v1')
    expect(output).not.toContain('Update Orca')
    expect(session.sendRequest).toHaveBeenCalledOnce()
  })

  it('renders the host UI while the host connection is still pending', async () => {
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain('HostContent')
  })

  it('does not mount host routes before a connected host passes the compatibility probe', async () => {
    const session = new FakeSession('connected')
    session.sendRequest.mockReturnValue(new Promise(() => {}))
    hostClient.current = { client: verifiedClient(session), state: 'connected' }
    renderer = await renderGate()
    const output = renderedText(renderer)
    expect(output).toContain('Checking host compatibility')
    expect(output).not.toContain('HostContent')
    expect(probeMounts.count).toBe(0)
    expect(session.sendRequest).toHaveBeenCalledOnce()
  })

  it('overlays the pending spinner instead of unmounting routes mounted while connecting', async () => {
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain('HostContent')
    expect(probeMounts.count).toBe(1)

    const session = new FakeSession('connected')
    session.sendRequest.mockReturnValue(new Promise(() => {}))
    await act(async () => {
      hostClient.current = { client: verifiedClient(session), state: 'connected' }
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
    const session = sessionWithStatus({ protocolVersion: 5, minCompatibleMobileVersion: 0 })
    const client = verifiedClient(session)
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()

    session.sendRequest.mockReturnValue(new Promise(() => {}))
    await act(async () => {
      session.publishState('disconnected')
      hostClient.current = { client, state: 'disconnected' }
      renderer?.update(gateElement())
    })
    await act(async () => {
      session.publishState('connected')
      hostClient.current = { client, state: 'connected' }
      renderer?.update(gateElement())
      await Promise.resolve()
    })

    const output = renderedText(renderer)
    expect(output).toContain('HostContent')
    // Why: the host already answered once, so a reconnect probe must not dim the UI it validated.
    expect(output).not.toContain('Checking host compatibility')
    expect(session.sendRequest).toHaveBeenCalledTimes(2)
    client.close()
  })

  it('offers recovery without mounting routes when a connected host cannot answer the status probe', async () => {
    const session = new FakeSession('connected')
    session.sendRequest.mockResolvedValue({
      id: '1',
      ok: false,
      error: { code: 'unavailable', message: 'unavailable' }
    })
    hostClient.current = { client: verifiedClient(session), state: 'connected' }
    renderer = await renderGate()
    expect(renderedText(renderer)).not.toContain('HostContent')
    expect(renderedText(renderer)).toContain('Unable to verify this host')
    expect(renderedText(renderer)).toContain('Retry')
    expect(renderedText(renderer)).not.toContain('Update Orca')
  })
  it.each([
    [{ protocolVersion: 2, minCompatibleMobileVersion: 2 }, 'Update Orca on your computer'],
    [{ protocolVersion: 3, minCompatibleMobileVersion: 4 }, 'Update Orca Mobile']
  ])('blocks the published range %j at the gate and the sender', async (status, title) => {
    const physical = new FakeSession('connected')
    physical.sendRequest.mockResolvedValue({ id: '1', ok: true, result: status })
    const client = verifiedClient(physical)
    await expect(client.sendRequest('worktree.ps')).rejects.toThrow('not been verified')
    hostClient.current = { client, state: 'connected' }
    const unsubscribe = client.subscribe('worktree.subscribe', {}, () => {})
    renderer = await renderGate()
    expect(renderedText(renderer)).toContain(title)
    expect(renderedText(renderer)).not.toContain('HostContent')
    await expect(client.sendRequest('worktree.ps')).rejects.toThrow('not been verified')
    expect(physical.sendRequest.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    expect(physical.subscribe).not.toHaveBeenCalled()
    unsubscribe()
    client.close()
  })

  it('preserves mounted navigation but closes admission across a stable-client cutover', async () => {
    const first = new FakeSession('connected')
    first.sendRequest.mockResolvedValue({
      id: '1',
      ok: true,
      result: {
        protocolVersion: 3,
        minCompatibleMobileVersion: 3
      }
    })
    const client = verifiedClient(first)
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
    const outcome = vi.fn()
    void client.sendRequest('worktree.ps').then(
      () => outcome('sent'),
      (error: Error) => outcome(error.message)
    )
    await act(async () => {
      await Promise.resolve()
    })
    // Why: nothing unverified may reach the replacement, but a screen's connect effect fires
    // a round trip ahead of the probe, so the request is held rather than failed.
    expect(outcome).not.toHaveBeenCalled()
    expect(replacement.sendRequest.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    expect(replacement.subscribe).not.toHaveBeenCalled()
    await act(async () => {
      resolveStatus({
        id: '2',
        ok: true,
        result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
      })
      await Promise.resolve()
    })
    expect(renderedText(renderer)).not.toContain('Checking host compatibility')
    expect(probeMounts.count).toBe(1)
    expect(replacement.subscribe).toHaveBeenCalledOnce()
    expect(outcome).toHaveBeenCalledWith('sent')
    expect(replacement.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'status.get',
      'worktree.ps'
    ])
    unsubscribe()
    client.close()
  })

  it('holds a verified host under the spinner, not the error card, while retries run', async () => {
    vi.useFakeTimers()
    const first = sessionWithStatus({ protocolVersion: 3, minCompatibleMobileVersion: 3 })
    const client = verifiedClient(first)
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

    // Why (F3): one failed probe must not bury a live terminal under a modal it cannot
    // dismiss; the routes stay mounted and the bounded retries run behind a spinner.
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
    const client = verifiedClient(physical)
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    await act(async () => {
      physical.publishState('disconnected')
      hostClient.current = { client, state: 'disconnected' }
      renderer?.update(gateElement())
    })
    physical.sendRequest.mockResolvedValue({
      id: '2',
      ok: false,
      error: { code: 'unavailable', message: 'offline' }
    })
    await act(async () => {
      physical.publishState('connected')
      hostClient.current = { client, state: 'connected' }
      renderer?.update(gateElement())
    })
    expect(renderedText(renderer)).toContain('HostContent')
    expect(renderedText(renderer)).not.toContain('Unable to verify')
    expect(probeMounts.count).toBe(1)
    await client.sendRequest('worktree.ps')
    expect(physical.sendRequest.mock.calls.at(-1)?.[0]).toBe('worktree.ps')
    client.close()
  })

  it('bounds automatic retries and recovers after the Retry action', async () => {
    vi.useFakeTimers()
    const session = new FakeSession('connected')
    const sendRequest = session.sendRequest
    sendRequest.mockRejectedValue(new Error('offline'))
    const client = verifiedClient(session)
    hostClient.current = { client, state: 'connected' }
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
    client.close()
  })

  it.each([
    null,
    [],
    true,
    { protocolVersion: '3', minCompatibleMobileVersion: 3 },
    { protocolVersion: 3, minCompatibleMobileVersion: -1 }
  ])('keeps malformed status %j unknown', async (result) => {
    hostClient.current = {
      client: verifiedClient(sessionWithStatus(result)),
      state: 'connected'
    }
    renderer = await renderGate()
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
      hostClient.current = {
        client: verifiedClient(sessionWithStatus(result)),
        state: 'connected'
      }
      renderer = await renderGate()
      expect(renderedText(renderer)).toContain('Update Orca on your computer')
      expect(renderedText(renderer)).toContain('Open GitHub Releases')
      expect(renderedText(renderer)).not.toContain('Unable to verify')
      expect(renderedText(renderer)).not.toContain('HostContent')
    }
  )

  it('fences connect effects under an already-mounted navigation tree', async () => {
    const physical = new FakeSession('connected')
    let resolveStatus!: (value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void
    physical.sendRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve
      })
    )
    const client = verifiedClient(physical)
    const outcome = vi.fn()
    function NestedRoute({ connected }: { connected: boolean }) {
      useEffect(() => {
        if (connected) {
          void client.sendRequest('worktree.ps').then(
            () => outcome('sent'),
            (error: Error) => outcome(error.message)
          )
        }
      }, [connected])
      return createElement(MountProbe)
    }
    const element = (connected: boolean) =>
      createElement(
        HostProtocolGate,
        { hostId: 'host-1' },
        createElement(NestedRoute, { connected })
      )
    hostClient.current = { client: null, state: 'connecting' }
    await act(async () => {
      renderer = create(element(false))
    })
    await act(async () => {
      hostClient.current = { client, state: 'connected' }
      renderer?.update(element(true))
    })
    // The connect effect ran pre-verdict, so its request is withheld from the host.
    expect(outcome).not.toHaveBeenCalled()
    expect(physical.sendRequest.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    expect(probeMounts.count).toBe(1)
    await act(async () => {
      resolveStatus({
        id: '1',
        ok: true,
        result: { protocolVersion: 3, minCompatibleMobileVersion: 3 }
      })
      await Promise.resolve()
    })
    expect(outcome).toHaveBeenCalledWith('sent')
    expect(physical.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'status.get',
      'worktree.ps'
    ])
    expect(probeMounts.count).toBe(1)
    client.close()
  })

  it('cancels the queued retry when the session changes or the client closes', async () => {
    vi.useFakeTimers()
    const first = new FakeSession('connected')
    first.sendRequest.mockRejectedValue(new Error('offline'))
    const client = verifiedClient(first)
    hostClient.current = { client, state: 'connected' }
    renderer = await renderGate()
    expect(first.sendRequest).toHaveBeenCalledOnce()
    const replacement = new FakeSession('connected')
    replacement.sendRequest.mockRejectedValue(new Error('still offline'))
    await act(async () => {
      await client.migrateTo(replacement, 'relay')
    })
    // The cutover drops the old generation's queued retry and starts the replacement's own.
    expect(replacement.sendRequest).toHaveBeenCalledOnce()
    const otherSession = sessionWithStatus({ protocolVersion: 3, minCompatibleMobileVersion: 3 })
    const other = verifiedClient(otherSession)
    await act(async () => {
      hostClient.current = { client: other, state: 'connected' }
      renderer?.update(
        createElement(HostProtocolGate, { hostId: 'host-2' }, createElement(MountProbe))
      )
    })
    client.close()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(first.sendRequest).toHaveBeenCalledOnce()
    expect(replacement.sendRequest).toHaveBeenCalledOnce()
    expect(otherSession.sendRequest).toHaveBeenCalledOnce()
    expect(renderedText(renderer)).not.toContain('Unable to verify')
    other.close()
  })
  it('ignores an old-generation success after cutover to a refusing session', async () => {
    const first = new FakeSession('connected')
    let resolveOld!: (value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void
    first.sendRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveOld = resolve
      })
    )
    const client = verifiedClient(first)
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
    expect(renderedText(renderer)).toContain('Unable to verify this host')
    expect(renderedText(renderer)).not.toContain('HostContent')
    await expect(client.sendRequest('worktree.ps')).rejects.toThrow('not been verified')
    expect(replacement.sendRequest.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    client.close()
  })
})
