import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { MobileCommitsScreen } from './MobileCommitsScreen'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: ({
    data,
    renderItem
  }: {
    data: { id: string }[]
    renderItem: (info: { item: { id: string } }) => ReactElement
  }) =>
    createElement(
      'FlatList',
      null,
      data.map((item) => createElement('Row', { key: item.id }, renderItem({ item })))
    ),
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'Icon',
  ArrowDownUp: 'Icon',
  ArrowUp: 'Icon',
  Check: 'Icon',
  ChevronLeft: 'Icon',
  ChevronRight: 'Icon',
  CircleAlert: 'Icon',
  CloudUpload: 'Icon',
  Copy: 'Icon',
  ExternalLink: 'Icon',
  GitBranch: 'Icon',
  GitCommitHorizontal: 'Icon',
  GitPullRequestArrow: 'Icon',
  History: 'Icon',
  MoreHorizontal: 'Icon',
  RefreshCw: 'Icon',
  WifiOff: 'Icon'
}))
// The pager's slide is Reanimated; render the main list and the open page side by side.
vi.mock('../../components/bottom-drawer/BottomDrawer', async () => {
  const { createElement: h, useCallback, useState } = await import('react')
  return {
    useOptionPager: () => {
      const [page, setPage] = useState<string | null>(null)
      const forget = useCallback(() => setPage(null), [])
      return { page, open: setPage, close: forget, forget }
    },
    OptionPager: ({ main, page }: { main: ReactElement; page: ReactElement | null }) =>
      h('View', null, main, page)
  }
})
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
const backClaim = vi.hoisted(() => {
  const holder: { current: (() => boolean) | null } = { current: null }
  return holder
})
vi.mock('../../navigation/use-back-claim', () => ({
  useBackClaim: (claim: (() => boolean) | null) => {
    backClaim.current = claim
  }
}))
vi.mock('../../components/nav-bar/NavBar', () => ({ NavBar: () => null }))
vi.mock('../../components/nav-bar/NavBarButton', () => ({ NavBarButton: () => null }))
vi.mock('../../components/nav-bar/PullDownMenu', () => ({ PullDownMenu: () => null }))
vi.mock('../../components/list/ListGroup', async () => {
  const { createElement: h } = await import('react')
  return {
    ListGroup: ({ children }: { children: ReactElement }) => h('View', null, children),
    ListRow: ({ title, value }: { title: string; value?: string }) => h('Text', null, title, value),
    SectionHeader: ({ title }: { title: string }) => h('Text', null, title)
  }
})
vi.mock('../../platform/clipboard/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: vi.fn() })
}))
vi.mock('../../platform/external-links/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../../platform/haptics/haptics', () => ({ triggerSuccess: vi.fn() }))
const transport = vi.hoisted(
  (): { forceReconnect: ((hostId: string) => Promise<void>) | null } => ({
    forceReconnect: () => Promise.resolve()
  })
)
vi.mock('../../transport/connection/host-client-hooks', () => ({
  useForceReconnect: () => transport.forceReconnect
}))

// The list stamps relative times from the clock; pin it so the bucket cannot move mid-test.
const RENDER_NOW = Date.UTC(2026, 10, 1, 12)

function historyResponse(subject: string): RpcResponse {
  return {
    id: 'history',
    ok: true,
    result: {
      items: [
        {
          id: 'commit-1',
          displayId: 'c0mm1t1',
          subject,
          author: 'Ada',
          parentIds: [],
          timestamp: RENDER_NOW - 3 * 3_600_000
        }
      ]
    }
  }
}

const compareResponse: RpcResponse = {
  id: 'compare',
  ok: true,
  result: { entries: [{ path: 'src/app.ts', added: 3, removed: 1 }] }
}

const BASE_REF_METHODS = new Set(['worktree.show', 'repo.list', 'repo.baseRefDefault'])

// No pinned or default base: the list asks for HEAD's history, as on a host without one.
function routedSend(
  history: () => Promise<RpcResponse>,
  compare: () => Promise<RpcResponse> = () => Promise.resolve(compareResponse)
) {
  return vi.fn((method: string): Promise<RpcResponse> => {
    if (method === 'git.history') {
      return history()
    }
    if (method === 'git.commitCompare') {
      return compare()
    }
    if (method === 'git.remoteCommitUrl') {
      return Promise.resolve({ id: 'url', ok: true, result: null })
    }
    if (BASE_REF_METHODS.has(method)) {
      return Promise.resolve({ id: method, ok: true, result: null })
    }
    throw new Error(`Unexpected ${method}`)
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

describe('MobileCommitsScreen', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(RENDER_NOW)
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  function listElement(client: RpcClient | null, connState: ConnectionState, worktreeId = 'wt-1') {
    return createElement(MobileCommitsScreen, {
      client,
      connState,
      worktreeId,
      hostId: 'host-1',
      bottomInset: 0
    })
  }

  async function render(client: RpcClient, connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer = create(listElement(client, connState))
      await settle()
    })
  }

  async function update(
    client: RpcClient | null,
    connState: ConnectionState,
    worktreeId?: string
  ): Promise<void> {
    await act(async () => {
      renderer?.update(listElement(client, connState, worktreeId))
      await settle()
    })
  }

  function tree(): string {
    return JSON.stringify(renderer?.toJSON())
  }

  it('wipes commits when the worktree identity changes', async () => {
    let historyCalls = 0
    const sendRequest = routedSend(() => {
      historyCalls += 1
      return historyCalls === 1
        ? Promise.resolve(historyResponse('worktree one'))
        : new Promise(() => {})
    })
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    expect(tree()).toContain('worktree one')

    await update(client, 'connected', 'wt-2')
    expect(tree()).not.toContain('worktree one')
  })
})
