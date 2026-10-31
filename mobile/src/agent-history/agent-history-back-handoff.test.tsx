import type { ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Prove panel asks handoff to navigate Back: seam tests alone miss direct useRouter, whose back() cannot leave single-entry page.
// Resolve route-handoff/client-context to .web siblings like actual bundle; these substitutions reproduce the shipped graph.

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  dismissTo: vi.fn(),
  back: vi.fn(),
  /** One entry is what the entry's `replaceState` leaves, which is the page's usual state. */
  canGoBack: vi.fn(() => false)
}))

vi.mock('expo-router', () => ({ useRouter: () => router, usePathname: () => '/' }))

// Mock RN hosts as strings: Vitest cannot parse React Native Flow, but panel structure stays real.
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  SectionList: 'SectionList',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.web },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'Icon',
  ChevronLeft: 'Icon',
  CircleAlert: 'Icon',
  History: 'Icon',
  RefreshCw: 'Icon',
  Search: 'Icon',
  SearchX: 'Icon',
  TriangleAlert: 'Icon',
  X: 'Icon'
}))
// Reanimated needs native modules; the eased height is not under test.
vi.mock('../components/AutoHeight', () => ({
  AutoHeight: ({ children }: { children: unknown }) => children
}))
vi.mock('../platform/haptics', () => ({ triggerError: () => {}, triggerSuccess: () => {} }))
// Mock Metro PNG requires; no client means session list never renders here.
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))

vi.mock('../navigation/route-handoff', async () => await import('../navigation/route-handoff.web'))

vi.mock('../transport/client-context', async () => await import('../transport/client-context.web'))

// Mock hooks re-exported by web provider because real hooks require Expo runtime.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => null,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import {
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION
} from '../mobile-web-shell/bridge/bridge-envelope'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { RpcClientProvider } from '../transport/client-context.web'
import { MobileAgentSessionHistoryPanel } from './MobileAgentSessionHistoryPanel'

type Pair = ReturnType<typeof createFakeBridgePortPair>

function render(pair: Pair): ReactElement {
  return (
    <RpcClientProvider client={pair.client}>
      <MobileAgentSessionHistoryPanel hostId="host-a" worktreeId="wt-1" name="my worktree" />
    </RpcClientProvider>
  )
}

/** The panel's own chevron, found by the label a user reads rather than by tree position. */
function pressBack(tree: ReactTestRenderer): void {
  const back = tree.root.findAll(
    (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Back'
  )
  if (back.length !== 1) {
    throw new Error(`expected one Back control, found ${back.length}`)
  }
  act(() => {
    back[0]?.props.onPress()
  })
}

/** Every frame the page posted under the name, read off the lane rather than off a spy. */
function postedNames(pair: Pair): string[] {
  return pair.toShell
    .map((json) => JSON.parse(json))
    .filter((frame: { type?: string }) => frame.type === 'notify')
    .map((frame: { name?: string }) => frame.name ?? '(unnamed)')
}

let tree: ReactTestRenderer | null = null

async function mountPanel(): Promise<{ pair: Pair; tree: ReactTestRenderer }> {
  const mounted = createFakeBridgePortPair()
  await mounted.flush()
  let created: ReactTestRenderer | null = null
  await act(async () => {
    created = create(render(mounted))
  })
  if (created === null) {
    throw new Error('the panel did not mount')
  }
  tree = created
  return { pair: mounted, tree: created }
}

beforeEach(() => {
  router.back.mockClear()
  router.canGoBack.mockClear()
  router.canGoBack.mockReturnValue(false)
})

afterEach(() => {
  act(() => {
    tree?.unmount()
  })
  tree = null
})

describe("the agent-history panel's Back button inside the shell's page", () => {
  it('hands the pop to the shell, because this document has nowhere to go back to', async () => {
    const mounted = await mountPanel()
    expect(mounted.pair.client.getShellSession()).not.toBeNull()
    expect(postedNames(mounted.pair)).toEqual([])
    pressBack(mounted.tree)
    await mounted.pair.flush()

    const frames = mounted.pair.toShell
      .map((json) => JSON.parse(json))
      .filter((frame: { name?: string }) => frame.name === BRIDGE_NAVIGATE_BACK_NOTIFY)
    expect(frames).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }
    ])
    expect(router.back).not.toHaveBeenCalled()
  })

  it('pops this document when the page itself grew a stack', async () => {
    router.canGoBack.mockReturnValue(true)
    const mounted = await mountPanel()
    pressBack(mounted.tree)
    await mounted.pair.flush()

    expect(postedNames(mounted.pair)).not.toContain(BRIDGE_NAVIGATE_BACK_NOTIFY)
    expect(router.back).toHaveBeenCalled()
  })
})
