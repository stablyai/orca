import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type {
  ForceReconnect,
  RpcClientContextValue
} from '../transport/rpc-client-context-contract'

// Mount Retry under page web provider with .web handoff/client context; forward useForceReconnect to provider, since awaiting real hooks cyclic import deadlocks.

const doubles = vi.hoisted(
  (): {
    read: () => RpcClientContextValue | null
    nativeRedial: ForceReconnect | undefined
    connection: { client: RpcClient | null; state: string }
  } => ({
    read: () => null,
    nativeRedial: undefined,
    connection: { client: null, state: 'reconnecting' }
  })
)

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => false }),
  usePathname: () => '/'
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: { View: 'View' },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  SectionList: 'SectionList',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Dimensions: { get: () => ({ width: 390, height: 844 }) },
  Keyboard: { addListener: () => ({ remove() {} }), dismiss: () => {} },
  Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.web },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  StyleSheet: { absoluteFill: {}, create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Defs: 'Defs',
  LinearGradient: 'LinearGradient',
  Path: 'Path',
  Rect: 'Rect',
  Stop: 'Stop'
}))
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
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../navigation/route-handoff', async () => await import('../navigation/route-handoff.web'))
vi.mock('../transport/client-context', async () => await import('../transport/client-context.web'))
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () =>
    doubles.nativeRedial === undefined ? doubles.read()?.forceReconnect : doubles.nativeRedial,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ ...doubles.connection, clientId: null }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { RpcClientProvider, useRpcClientContext } from '../transport/client-context.web'
import { MobileAgentSessionHistoryPanel } from './MobileAgentSessionHistoryPanel'

doubles.read = useRpcClientContext

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  doubles.nativeRedial = undefined
  doubles.connection = { client: null, state: 'reconnecting' }
})

function panel(pair: ReturnType<typeof createFakeBridgePortPair>) {
  return (
    <RpcClientProvider client={pair.client}>
      <MobileAgentSessionHistoryPanel hostId="host-a" worktreeId="wt-1" name="my worktree" />
    </RpcClientProvider>
  )
}

async function mountPanel(
  pair: ReturnType<typeof createFakeBridgePortPair> = createFakeBridgePortPair()
): Promise<ReactTestRenderer> {
  await pair.flush()
  await act(async () => {
    tree = create(panel(pair))
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

  it('loads again when the shell reconnects, which is what the missing Retry relies on', async () => {
    // Page never redials itself; rerun load against client/state delivered by shell reconnect.
    const pair = createFakeBridgePortPair()
    const rendered = await mountPanel(pair)
    expect(retryControls(rendered)).toHaveLength(0)
    const client = createFakeRpcClient()
    doubles.connection = { client, state: 'connected' }
    await act(async () => {
      rendered.update(panel(pair))
    })
    expect(client.requests.map((request) => request.method)).toContain('status.get')
  })
})

it.each([
  ['host-b', 0, false],
  ['host-a', 1, true]
] as const)(
  'owns the history catalog across a client replacement for %s',
  async (hostId, retainedLists, alreadyScanning) => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const session: AiVaultSession = {
      id: 'claude:host-a',
      executionHostId: 'local',
      agent: 'claude',
      sessionId: 'host-a-session',
      title: 'Host A session',
      cwd: '/host-a/workspace',
      branch: null,
      model: null,
      filePath: '/host-a/session.jsonl',
      codexHome: null,
      createdAt: null,
      updatedAt: null,
      modifiedAt: '2026-10-21T00:00:00.000Z',
      messageCount: 2,
      totalTokens: 10,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: '',
      subagent: null
    }
    const reply = (result: unknown): RpcResponse => ({ id: 'history', ok: true, result })
    const previous = new FakeSession('connected')
    previous.sendRequest.mockImplementation(async (method) =>
      reply(
        method === 'status.get'
          ? { capabilities: ['aiVault.v1'], hostPlatform: 'darwin' }
          : method === 'worktree.ps'
            ? { worktrees: [{ worktreeId: 'wt-1', repoId: 'repo', path: '/host-a/workspace' }] }
            : { sessions: [session], issues: [] }
      )
    )
    doubles.connection = { client: previous, state: 'connected' }
    const renderHost = (hostId: string) => (
      <RpcClientProvider client={pair.client}>
        <MobileAgentSessionHistoryPanel hostId={hostId} worktreeId="wt-1" />
      </RpcClientProvider>
    )
    await act(async () => {
      tree = create(renderHost('host-a'))
    })
    expect(tree?.root.findAll((node) => String(node.type) === 'SectionList')).toHaveLength(1)
    const next = new FakeSession('connected')
    let answerWorktrees: (reply: RpcResponse) => void = () => {}
    const worktrees = new Promise<RpcResponse>((resolve) => {
      answerWorktrees = resolve
    })
    next.sendRequest.mockImplementation(async (method) => {
      if (method === 'worktree.ps') {
        return worktrees
      }
      if (method === 'status.get') {
        return reply({ capabilities: ['aiVault.v1'], hostPlatform: 'linux' })
      }
      return new Promise<RpcResponse>(() => {})
    })
    doubles.connection = { client: next, state: 'connected' }
    await act(async () => tree?.update(renderHost(hostId)))
    expect(tree?.root.findAll((node) => String(node.type) === 'SectionList')).toHaveLength(
      retainedLists
    )
    expect(next.sendRequest.mock.calls.some(([method]) => method === 'aiVault.listSessions')).toBe(
      alreadyScanning
    )
    await act(async () =>
      answerWorktrees(
        reply({ worktrees: [{ worktreeId: 'wt-1', repoId: 'repo', path: '/host-b/workspace' }] })
      )
    )
    expect(next.sendRequest).toHaveBeenCalledWith(
      'aiVault.listSessions',
      expect.objectContaining({ scopePaths: ['/host-b/workspace'] })
    )
  }
)
