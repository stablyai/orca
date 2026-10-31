// Keep the real bridge host alive while leaving an in-page workspace: its unmount must release terminal streams and audio without native screen teardown.
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { createContext } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  Keyboard: { dismiss: () => {} },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} }),
  useClipboardReader: () => ({ contents: async () => ({ text: false, image: false }) })
}))
vi.mock('../platform/haptics', () => ({
  triggerSuccess: () => {},
  triggerError: () => {},
  triggerSelection: () => {},
  triggerEdgeBump: () => {}
}))
vi.mock('../terminal/terminal-copy-gutter-preference', () => ({
  useTerminalCopyTrimsGutter: () => ({ current: false })
}))
vi.mock('../session/mobile-session-styles', () => ({ styles: { container: {}, kavInner: {} } }))
vi.mock('../transport/use-workspace-client', () => ({
  WorkspaceServerContext: createContext(undefined)
}))
vi.mock('../components/AnchoredDetailCard', () => ({ AnchoredDetailCard: () => null }))
vi.mock('../session/MobileSessionTabCardFooter', () => ({ MobileSessionTabCardFooter: () => null }))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isLandscapePhone: false })
}))
vi.mock('../layout/use-shell-side-rail', () => ({ useShellSideRail: () => false }))
vi.mock('../session/use-session-title-card', () => ({
  useSessionTitleCard: () => ({ active: false, visual: null, tabId: null, missingTab: false })
}))
vi.mock('../session/MobileSessionHeader', () => ({ MobileSessionHeader: () => null }))
vi.mock('../session/MobileSessionContentRow', () => ({ MobileSessionContentRow: () => null }))
vi.mock('../session/MobileSessionSheets', () => ({ MobileSessionSheets: () => null }))
vi.mock('../session/MobileWorkerAutoCloseStrip', () => ({ MobileWorkerAutoCloseStrip: () => null }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => () => void) => useEffect(effect, [effect]) }
})
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))
// The page bundle resolves the `.web` sibling; vitest would take the native one.
vi.mock('../platform/dictation-capture', () => import('../platform/dictation-capture.web'))

import { RpcClientProvider } from '../transport/client-context.web'
import { useMobileDictation, type UseMobileDictationResult } from '../hooks/use-mobile-dictation'
import { createNativeAudioCapture, type NativeAudioEngine } from '../platform/native-audio'
import { subscribeMobileTerminalSafely } from '../session/mobile-terminal-stream-subscribe'
import { useMobileSessionTerminalSubscriptionFoundation } from '../session/use-mobile-session-terminal-subscription-foundation'
import { useMobileSessionAccessorySelection } from '../session/use-mobile-session-accessory-selection'
import { MobileSessionSurface } from '../session/MobileSessionSurface'
import { createFakeRpcClient, type FakeRpcClient } from './bridge-host-test-fakes'
import { createFakeBridgePortPair } from './bridge/bridge-port-pair-test-harness'
import type { BridgeNativeVerb } from './bridge/bridge-native-verbs'
import { routeViewOf } from './page-route-policy'

type FoundationScope = Parameters<typeof useMobileSessionTerminalSubscriptionFoundation>[0]
type AccessoryScope = Parameters<typeof useMobileSessionAccessorySelection>[0]
type SurfaceController = Parameters<typeof MobileSessionSurface>[0]['controller']

const HOST_AREA_GRANTS = routeViewOf(
  [
    { pathname: '/h/[hostId]', grants: ['navigate'], canOwnHostArea: true },
    {
      pathname: '/h/[hostId]/session/[worktreeId]',
      grants: ['navigate', 'native.audio.start', 'native.audio.read', 'native.audio.stop']
    }
  ],
  '/h/host-a',
  true
).routeGrants

function hostAreaPair(device: string[]) {
  const engine: NativeAudioEngine = {
    requestPermission: async () => 'granted',
    open: async (sampleRate) => ({ opened: true, sampleRate }),
    begin: () => {
      device.push('mic-open')
      return true
    },
    end: () => device.push('mic-closed'),
    screenLock: { hold: () => device.push('awake'), release: () => device.push('asleep') },
    onMicrophoneData: () => ({ remove: () => {} }),
    onInterruption: () => ({ remove: () => {} })
  }
  const audio = createNativeAudioCapture(engine)
  return createFakeBridgePortPair({
    route: { pathname: '/h/host-a' },
    routeGrants: HOST_AREA_GRANTS,
    ownsHostArea: true,
    serveNativeVerb: (verb: BridgeNativeVerb, params: unknown) => {
      device.push(verb)
      return audio.serve(verb, params)
    }
  })
}

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function Composer({ desktop }: { desktop: FakeRpcClient }): null {
  held.dictation = useMobileDictation({
    client: desktop,
    enabled: true,
    onTranscript: () => {},
    onError: () => {}
  })
  return null
}

async function answerDesktop(desktop: FakeRpcClient, settle: () => Promise<void>): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of desktop.requests.splice(0)) {
      request.resolve({ id: 'desktop', ok: true, result: {} })
    }
    await settle()
  }
}

beforeEach(() => {
  held.dictation = null
})

describe('leaving a workspace inside the host-area page', () => {
  it('releases every terminal stream when the session root detaches, so the PTY is restored', async () => {
    const pair = hostAreaPair([])
    await pair.flush()
    const terminalUnsubsRef = { current: new Map<string, () => void>() }
    function SessionTerminals() {
      const scope = {
        setCoveredStreamRevision: () => {},
        setTerminalKeyboardMetrics: () => {},
        terminalCwdRef: { current: new Map() },
        terminalRefs: { current: new Map() },
        terminalUnsubsRef,
        subscribingHandlesRef: { current: new Set() },
        leaseOnlyHandlesRef: { current: new Set() },
        initializedHandlesRef: { current: new Set() },
        terminalDiagnosticsRef: { current: { clearTerminalCache: () => {} } },
        viewportResubscribeBudgetRef: { current: { clear: () => {} } },
        webReadyHandlesRef: { current: new Set() },
        activeHandleRef: { current: null },
        subscribeSeqRef: { current: new Map() },
        layoutSeqRef: { current: new Map() },
        nativeChatInputLeaseReadyRef: { current: false },
        clearNativeChatInputLease: () => {},
        showNativeChatRef: { current: false },
        worktreeId: 'folder:remote',
        isFloatingWorkspaceRoute: false,
        client: pair.client,
        connState: 'connected',
        setSelectModeActive: () => {},
        setCanPaste: () => {},
        toastSeqRef: { current: 0 },
        ptyModesRef: { current: new Map() },
        initialModesSeenRef: { current: new Set() },
        liveInputFocusTimerRef: { current: null },
        sessionTabActionSheetRequestSeqRef: { current: 0 },
        clearPendingLiveInputCommit: () => {},
        clearDelayedActionTimers: () => {},
        clearToastHideTimer: () => {},
        showToast: () => {},
        handleAccessoryKey: () => {},
        clearSessionTabActionSheetKeyboardListener: () => {}
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the foundation destructures only the fields built above.
      const typed = scope as unknown as FoundationScope
      const foundation = useMobileSessionTerminalSubscriptionFoundation(typed)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the accessory hook reads the listed scope and actual foundation callbacks.
      const accessoryScope = { ...scope, ...foundation } as unknown as AccessoryScope
      const accessory = useMobileSessionAccessorySelection(accessoryScope)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the actual surface reads the root ref, tabs and sheet visibility; its presentation children are stubbed.
      const controller = {
        ...accessory,
        visibleTabs: [],
        bulkCloseConfirm: { visible: false }
      } as unknown as SurfaceController
      return <MobileSessionSurface controller={controller} />
    }
    const mounted: { tree: ReactTestRenderer | null } = { tree: null }
    try {
      act(() => {
        mounted.tree = create(<SessionTerminals />, { createNodeMock: () => ({}) })
      })
      for (const terminal of ['pty-1', 'pty-2']) {
        terminalUnsubsRef.current.set(
          terminal,
          subscribeMobileTerminalSafely(
            pair.client,
            { terminal, client: { id: 'phone' }, viewport: { cols: 60, rows: 30 } },
            () => {},
            () => {}
          )
        )
      }
      await pair.flush()
      expect(
        pair.rpc.streams.map((stream) => [stream.method, stream.params, stream.unsubscribes])
      ).toEqual([
        [
          'terminal.subscribe',
          { terminal: 'pty-1', client: { id: 'phone' }, viewport: { cols: 60, rows: 30 } },
          0
        ],
        [
          'terminal.subscribe',
          { terminal: 'pty-2', client: { id: 'phone' }, viewport: { cols: 60, rows: 30 } },
          0
        ]
      ])
      act(() => mounted.tree?.unmount())
      mounted.tree = null
      await pair.flush()
      expect(pair.rpc.streams.map((stream) => stream.unsubscribes)).toEqual([1, 1])
      expect(terminalUnsubsRef.current.size).toBe(0)
      const params = {
        terminal: 'pty-after-detach',
        client: { id: 'phone' },
        viewport: { cols: 60, rows: 30 }
      }
      const unsubscribe = subscribeMobileTerminalSafely(
        pair.client,
        params,
        () => {},
        () => {}
      )
      await pair.flush()
      expect(pair.rpc.streams[2]).toMatchObject({
        method: 'terminal.subscribe',
        params,
        unsubscribes: 0
      })
      unsubscribe()
      await pair.flush()
      expect(pair.rpc.streams.slice(0, 2).map((stream) => stream.unsubscribes)).toEqual([1, 1])
      expect(pair.rpc.streams[2]?.unsubscribes).toBe(1)
    } finally {
      act(() => mounted.tree?.unmount())
      pair.client.close()
      pair.host.dispose()
    }
  })

  it('closes the microphone and lets the screen sleep when the composer unmounts', async () => {
    const device: string[] = []
    const pair = hostAreaPair(device)
    await pair.flush()
    const desktop = createFakeRpcClient()
    const mounted: { tree: ReactTestRenderer | null } = { tree: null }
    act(() => {
      mounted.tree = create(
        <RpcClientProvider client={pair.client}>
          <Composer desktop={desktop} />
        </RpcClientProvider>
      )
    })
    await act(async () => {
      void held.dictation?.start().catch(() => undefined)
      await answerDesktop(desktop, () => pair.flush())
    })
    expect(held.dictation?.status).toBe('recording')
    expect(device).toContain('mic-open')

    await act(async () => {
      mounted.tree?.unmount()
      await answerDesktop(desktop, () => pair.flush())
    })
    expect(device).toEqual(expect.arrayContaining(['native.audio.stop', 'mic-closed', 'asleep']))
    expect(device.lastIndexOf('mic-closed')).toBeGreaterThan(device.lastIndexOf('mic-open'))
  })
})
