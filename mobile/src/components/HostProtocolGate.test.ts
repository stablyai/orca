import { createElement, useEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileSessionStartup } from '../session/use-mobile-session-startup'
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
  StyleSheet: {
    create: <T>(styles: T) => styles,
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }
  },
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

// Why: mirrors the route's foundation -> startup plumbing (statusPending from the gate feeding the
// real startup hook) so the assertion lands on the shipped hook, not a restatement of it.
type StartupScope = Parameters<typeof useMobileSessionStartup>[0]

function createStartupScope() {
  const noop = () => {}
  return {
    created: undefined as string | undefined,
    activeHandleRef: { current: null as string | null },
    hostId: 'host-1',
    worktreeId: 'wt-1',
    isFloatingWorkspaceRoute: false,
    setTerminals: noop,
    terminalsRef: { current: [] },
    setSessionTabs: noop,
    appliedSnapshotMarkerRef: { current: { epoch: null, version: -1 } },
    closedTabTombstonesRef: { current: new Map() },
    setTerminalsLoaded: noop,
    setActiveHandle: noop,
    setActiveSessionTabId: noop,
    setMarkdownDocs: noop,
    setFileDocs: noop,
    terminalGestureInputQueuesRef: { current: new Map() },
    terminalGestureInputInFlightRef: { current: new Set() },
    sessionTabActionSheetKeyboardHideSubRef: { current: null },
    sessionTabActionSheetRequestSeqRef: { current: 0 },
    initializedHandlesRef: { current: new Set() },
    terminalDiagnosticsRef: { current: { resetRoute: noop } },
    activeSessionTabTypeRef: { current: null },
    pendingActiveSessionTabIdRef: { current: null },
    selectedSessionTabIdRef: { current: null },
    pendingActiveTerminalHandleRef: { current: null },
    pendingBrowserFocusPageIdRef: { current: null },
    pendingTerminalActivationAttemptRef: { current: null },
    initialSessionAutoCreateRef: { current: null },
    bufferedTerminalDraftState: { resetDrafts: noop, clearPendingRestorations: noop },
    clearPendingLiveInputCommit: noop,
    clearDelayedActionTimers: noop,
    showToast: noop,
    clearTerminalCache: noop,
    fetchTerminals: async () => true,
    ensureSessionTabs: async () => {}
  }
}

let startupScope = createStartupScope()

function StartupProbe() {
  const { statusPending } = useHostProtocolGates()
  useMobileSessionStartup({
    ...startupScope,
    client: hostClient.current.client,
    connState: hostClient.current.state,
    statusPending
  } as unknown as StartupScope)
  return createElement('StartupProbe')
}

// status.get stays unresolved until the test settles it; every other method lands on `activate`.
function clientWithDeferredStatus() {
  let resolveStatus: (result: Record<string, unknown>) => void = () => {}
  const status = new Promise<{ ok: true; result: Record<string, unknown> }>((resolve) => {
    resolveStatus = (result) => resolve({ ok: true, result })
  })
  const activate = vi.fn().mockResolvedValue({ ok: true, result: {} })
  const client = {
    sendRequest: (method: string, params?: unknown) =>
      method === 'status.get' ? status : activate(method, params)
  } as unknown as RpcClient
  return { activate, client, settle: (result: Record<string, unknown>) => resolveStatus(result) }
}

function startupGateElement() {
  return createElement(
    HostProtocolGate,
    { hostId: 'host-1' },
    createElement('HostContent', null, createElement(StartupProbe))
  )
}

async function renderStartupGate(): Promise<ReactTestRenderer> {
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(startupGateElement())
    await Promise.resolve()
  })
  return created as unknown as ReactTestRenderer
}

describe('HostProtocolGate', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    nativeTestState.openUrl.mockClear()
    nativeTestState.platform.OS = 'ios'
    probeMounts.count = 0
    startupScope = createStartupScope()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
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
  // Reaches the connected-but-unverified window the way production does: the route mounts while the
  // client is still connecting, so the gate overlays it instead of holding the tree back.
  async function connectWithPendingStatus(client: RpcClient): Promise<void> {
    await act(async () => {
      hostClient.current = { client, state: 'connected' }
      renderer?.update(startupGateElement())
      await Promise.resolve()
    })
  }

  async function settleVerdict(settle: (result: Record<string, unknown>) => void): Promise<void> {
    await act(async () => {
      settle({ protocolVersion: 3, minCompatibleMobileVersion: 0 })
      await Promise.resolve()
    })
  }

  it('holds worktree.activate until the host compat verdict settles', async () => {
    const { activate, client, settle } = clientWithDeferredStatus()
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderStartupGate()
    expect(activate).not.toHaveBeenCalled()

    await connectWithPendingStatus(client)
    expect(renderedText(renderer)).toContain('Checking host compatibility')
    // Why: activate writes host state (protocol-1 hosts ignore notifyClients: false), so an
    // unknown verdict must not have produced one.
    expect(activate).not.toHaveBeenCalled()

    await settleVerdict(settle)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith('worktree.activate', {
      worktree: 'id:wt-1',
      notifyClients: false,
      navigation: 'caller'
    })
  })

  it('defers the created-workspace activate recovery past the pending verdict', async () => {
    vi.useFakeTimers()
    startupScope.created = '1'
    const { activate, client, settle } = clientWithDeferredStatus()
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderStartupGate()
    await connectWithPendingStatus(client)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(activate).not.toHaveBeenCalled()

    await settleVerdict(settle)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800)
    })
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith('worktree.activate', {
      worktree: 'id:wt-1',
      notifyClients: false,
      navigation: 'caller'
    })
  })

  it('sends one activate when hydration lands after the creation route is consumed', async () => {
    vi.useFakeTimers()
    startupScope.created = '1'
    // Slow hydration is the window the recovery timer must not beat.
    startupScope.ensureSessionTabs = () => new Promise<void>((resolve) => setTimeout(resolve, 3000))
    const { activate, client, settle } = clientWithDeferredStatus()
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderStartupGate()
    await connectWithPendingStatus(client)
    await settleVerdict(settle)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    // Hydration landed: a tab claims the active handle and autocreate consumes ?created=1.
    startupScope.activeHandleRef.current = 'term-1'
    startupScope.created = undefined
    await act(async () => {
      renderer?.update(startupGateElement())
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })

    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('never activates when the verdict comes back blocked', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { activate, client, settle } = clientWithDeferredStatus()
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderStartupGate()
    await connectWithPendingStatus(client)

    await act(async () => {
      settle({ protocolVersion: 1, minCompatibleMobileVersion: 0 })
      await Promise.resolve()
    })

    const output = renderedText(renderer)
    expect(output).toContain('Update Orca on your computer')
    expect(output).not.toContain('StartupProbe')
    expect(activate).not.toHaveBeenCalled()
  })

  it('skips the created-workspace activate recovery when a terminal is already active', async () => {
    vi.useFakeTimers()
    startupScope.created = '1'
    const { activate, client, settle } = clientWithDeferredStatus()
    hostClient.current = { client: null, state: 'connecting' }
    renderer = await renderStartupGate()
    await connectWithPendingStatus(client)
    await settleVerdict(settle)
    // The route reset clears this ref on mount, so a terminal can only claim it after the verdict.
    startupScope.activeHandleRef.current = 'term-1'

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(activate).not.toHaveBeenCalled()
  })
})
