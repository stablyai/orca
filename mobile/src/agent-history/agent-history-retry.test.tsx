import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ForceReconnect,
  RpcClientContextValue
} from '../transport/rpc-client-context-contract'

/**
 * The panel's Retry while the host is unreachable, mounted under the page's own provider.
 *
 * `client-context` and `route-handoff` resolve to their `.web` siblings, as the page bundle does.
 * `useForceReconnect` forwards to the provider this suite mounts rather than re-exporting the real
 * hook: the sibling imports the hooks back, and an awaited mock of it deadlocks.
 */

const doubles = vi.hoisted(
  (): { read: () => RpcClientContextValue | null; nativeRedial: ForceReconnect | undefined } => ({
    read: () => null,
    nativeRedial: undefined
  })
)

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => false }),
  usePathname: () => '/'
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
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
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'Icon', Play: 'Icon', RefreshCw: 'Icon' }))
vi.mock('../platform/haptics', () => ({ triggerError: () => {}, triggerSuccess: () => {} }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../navigation/route-handoff', async () => await import('../navigation/route-handoff.web'))
vi.mock('../transport/client-context', async () => await import('../transport/client-context.web'))
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () =>
    doubles.nativeRedial === undefined ? doubles.read()?.forceReconnect : doubles.nativeRedial,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'reconnecting' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { RpcClientProvider, useRpcClientContext } from '../transport/client-context.web'
import { MobileAgentSessionHistoryPanel } from './MobileAgentSessionHistoryPanel'

doubles.read = useRpcClientContext

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  doubles.nativeRedial = undefined
})

async function mountPanel(): Promise<ReactTestRenderer> {
  const pair = createFakeBridgePortPair()
  await pair.flush()
  await act(async () => {
    tree = create(
      <RpcClientProvider client={pair.client}>
        <MobileAgentSessionHistoryPanel hostId="host-a" worktreeId="wt-1" name="my worktree" />
      </RpcClientProvider>
    )
  })
  if (tree === null) {
    throw new Error('the panel did not mount')
  }
  return tree
}

function retryControls(rendered: ReactTestRenderer): ReactTestInstance[] {
  return rendered.root
    .findAll((node) => String(node.type) === 'Pressable')
    .filter((node) =>
      node
        .findAll((text) => String(text.type) === 'Text')
        .some((text) => text.props.children === 'Retry')
    )
}

describe("the agent-history panel's Retry while the host is unreachable", () => {
  it('is absent on the page, where nothing can re-dial', async () => {
    const rendered = await mountPanel()
    expect(
      rendered.root.findAll((node) => node.props.children === 'Waiting for host…')
    ).not.toHaveLength(0)
    expect(retryControls(rendered)).toHaveLength(0)
  })

  it('still renders natively and re-dials this host', async () => {
    const redial = vi.fn(() => Promise.resolve())
    doubles.nativeRedial = redial
    const [retry] = retryControls(await mountPanel())
    act(() => {
      retry?.props.onPress()
    })
    expect(redial.mock.calls).toEqual([['host-a']])
  })
})
