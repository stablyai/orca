import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { AiVaultScanIssue } from '../../../src/shared/ai-vault-types'

/**
 * The "N transcripts skipped" banner over a scan that also carries scanner
 * commentary.
 *
 * Mounted the same way agent-history-retry.test.tsx mounts the panel: the web
 * siblings of the transport and navigation modules, and a fake client the test
 * settles by hand.
 */

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

const connected = vi.hoisted((): { client: RpcClient | null } => ({ client: null }))

vi.mock('../transport/client-context', async () => await import('../transport/client-context.web'))
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => undefined,
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: connected.client, state: 'connected', clientId: null }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { RpcClientProvider } from '../transport/client-context.web'
import { MOBILE_AI_VAULT_CAPABILITY } from './agent-history-capability'
import { MobileAgentSessionHistoryPanel } from './MobileAgentSessionHistoryPanel'

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  connected.client = null
})

const session = {
  id: 'local:pi:big',
  executionHostId: 'local',
  agent: 'pi',
  sessionId: 'big',
  title: 'Big session',
  cwd: '/repos/orca',
  branch: null,
  model: null,
  filePath: '/sessions/big.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-05-01T10:00:00.000Z',
  messageCount: 3,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'pi --resume big',
  subagent: null
}

/**
 * The scan only fires once the capability gate and the worktree catalog have
 * answered, so the panel has to be driven through every pending call rather
 * than one method at a time.
 */
async function settleAll(
  client: FakeRpcClient,
  replies: Record<string, unknown>,
  rounds = 6
): Promise<void> {
  let settled = 0
  for (let round = 0; round < rounds; round++) {
    const pending = client.requests.slice(settled)
    settled = client.requests.length
    await act(async () => {
      for (const request of pending) {
        request.resolve({ id: request.method, ok: true, result: replies[request.method] ?? {} })
      }
    })
  }
}

async function mountWithIssues(issues: readonly AiVaultScanIssue[]): Promise<ReactTestRenderer> {
  const client = createFakeRpcClient()
  connected.client = client
  const pair = createFakeBridgePortPair()
  await pair.flush()
  await act(async () => {
    tree = create(
      <RpcClientProvider client={pair.client}>
        <MobileAgentSessionHistoryPanel hostId="host-a" worktreeId="wt-1" name="my worktree" />
      </RpcClientProvider>
    )
  })
  await settleAll(client, {
    'status.get': { capabilities: [MOBILE_AI_VAULT_CAPABILITY] },
    'worktree.ps': { worktrees: [] },
    'aiVault.listSessions': {
      sessions: [session],
      issues,
      scannedAt: '2026-05-01T10:00:00.000Z'
    }
  })
  if (tree === null) {
    throw new Error('the panel did not mount')
  }
  return tree
}

function renderedText(rendered: ReactTestRenderer): string[] {
  return rendered.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => String(node.props.children))
}

function bannerTexts(rendered: ReactTestRenderer): string[] {
  return renderedText(rendered).filter((text) => text.includes('skipped'))
}

/**
 * Guards against a vacuous pass: an unsettled panel renders no banner either.
 * The list is the mocked `SectionList`, so its rows never render — its presence
 * is what says the scan landed and the session was listed.
 */
function expectListed(rendered: ReactTestRenderer): void {
  expect(renderedText(rendered)).not.toContain('No agent sessions')
  expect(rendered.root.findAll((node) => String(node.type) === 'SectionList')).toHaveLength(1)
}

const noticeIssue: AiVaultScanIssue = {
  executionHostId: 'local',
  agent: 'pi',
  kind: 'notice',
  path: '/sessions/big.jsonl',
  message: 'Skipped 1 oversized transcript record over the 10.0 MiB limit.'
}

const unreadableIssue: AiVaultScanIssue = {
  executionHostId: 'local',
  agent: 'pi',
  path: '/sessions/broken.jsonl',
  message: 'Unreadable transcript.'
}

// Why: #22480 — the parse cache replays this note on every scan, so mobile showed
// a permanent "1 transcript skipped" for a session it had listed successfully.
it('does not count scanner commentary as a skipped transcript', async () => {
  const rendered = await mountWithIssues([noticeIssue])

  expectListed(rendered)
  expect(bannerTexts(rendered)).toEqual([])
})

it('still reports a transcript the scan could not read', async () => {
  const rendered = await mountWithIssues([unreadableIssue, noticeIssue])

  expectListed(rendered)
  expect(bannerTexts(rendered).join('')).toContain('1')
})
