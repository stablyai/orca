import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
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
vi.mock('../components/BottomDrawer', async () => {
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
vi.mock('../navigation/use-back-claim', () => ({
  useBackClaim: (claim: (() => boolean) | null) => {
    backClaim.current = claim
  }
}))
vi.mock('../components/nav-bar/NavBar', () => ({ NavBar: () => null }))
vi.mock('../components/nav-bar/NavBarButton', () => ({ NavBarButton: () => null }))
vi.mock('../components/nav-bar/PullDownMenu', () => ({ PullDownMenu: () => null }))
vi.mock('../components/list/ListGroup', async () => {
  const { createElement: h } = await import('react')
  return {
    ListGroup: ({ children }: { children: ReactElement }) => h('View', null, children),
    ListRow: ({ title, value }: { title: string; value?: string }) => h('Text', null, title, value),
    SectionHeader: ({ title }: { title: string }) => h('Text', null, title)
  }
})
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText: vi.fn() }) }))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn() }))
const transport = vi.hoisted(
  (): { forceReconnect: ((hostId: string) => Promise<void>) | null } => ({
    forceReconnect: () => Promise.resolve()
  })
)
vi.mock('../transport/host-client-hooks', () => ({
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

function callsOf(send: ReturnType<typeof routedSend>, method: string) {
  return send.mock.calls.filter(([called]) => called === method)
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

  async function openFirstCommit(): Promise<void> {
    const row = renderer?.root.findAll(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'expandable'
    )[0]
    await act(async () => {
      row?.props.onPress()
      await settle()
    })
  }

  it('keeps loaded commits visible across a disconnect and its reconnect refetch', async () => {
    let releaseRefetch: (() => void) | null = null
    let historyCalls = 0
    const sendRequest = routedSend(() => {
      historyCalls += 1
      return historyCalls === 1
        ? Promise.resolve(historyResponse('first load'))
        : new Promise((resolve) => {
            releaseRefetch = () => resolve(historyResponse('after reconnect'))
          })
    })
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    expect(tree()).toContain('first load')
    // RPC timestamps are epoch milliseconds; seconds rescaling would show every commit as just now.
    expect(tree()).toContain('3h')

    await update(client, 'reconnecting')
    expect(tree()).toContain('first load')

    await update(client, 'connected')
    expect(tree()).toContain('first load')

    await act(async () => {
      releaseRefetch?.()
      await settle()
    })
    expect(tree()).toContain('after reconnect')
    expect(callsOf(sendRequest, 'git.history')).toHaveLength(2)
  })

  it('keeps loaded commits when a refetch fails after the host drops again', async () => {
    let failRefetch: ((error: Error) => void) | null = null
    let historyCalls = 0
    const client = createFakeRpcClient()
    client.sendRequest = routedSend(() => {
      historyCalls += 1
      return historyCalls === 1
        ? Promise.resolve(historyResponse('first load'))
        : new Promise((_resolve, reject) => {
            failRefetch = reject
          })
    })

    await render(client, 'connected')
    await update(client, 'reconnecting')
    await update(client, 'connected')
    await update(client, 'reconnecting')
    await act(async () => {
      failRefetch?.(new Error('Connection lost'))
      await settle()
    })
    expect(tree()).toContain('first load')
    expect(tree()).not.toContain('Connection lost')
  })

  it('reloads history on a pull and spins until it lands', async () => {
    let finishPull: (() => void) | null = null
    let historyCalls = 0
    const client = createFakeRpcClient()
    client.sendRequest = routedSend(() => {
      historyCalls += 1
      return historyCalls === 1
        ? Promise.resolve(historyResponse('before pull'))
        : new Promise((resolve) => {
            finishPull = () => resolve(historyResponse('after pull'))
          })
    })
    await render(client, 'connected')
    expect(tree()).toContain('before pull')

    const list = renderer?.root.find((node) => node.props.refreshControl !== undefined)
    await act(async () => {
      list?.props.refreshControl.props.onRefresh()
      await settle()
    })
    expect(list?.props.refreshControl.props.refreshing).toBe(true)

    await act(async () => {
      finishPull?.()
      await settle()
    })
    expect(tree()).toContain('after pull')
    expect(list?.props.refreshControl.props.refreshing).toBe(false)
  })

  it("opens a commit's file in the shared diff screen against that commit", async () => {
    const openDiffForFile = vi.fn()
    const client = createFakeRpcClient()
    client.sendRequest = routedSend(() => Promise.resolve(historyResponse('expandable')))
    await act(async () => {
      renderer = create(
        createElement(MobileCommitsScreen, {
          client,
          connState: 'connected',
          worktreeId: 'wt-1',
          hostId: 'host-1',
          bottomInset: 0,
          openDiffForFile
        })
      )
      await settle()
    })
    await openFirstCommit()
    const fileRow = renderer?.root.find(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'src/app.ts'
    )
    await act(async () => fileRow?.props.onPress())
    expect(openDiffForFile).toHaveBeenCalledWith({
      kind: 'commit',
      filePath: 'src/app.ts',
      commitOid: 'commit-1'
    })
  })

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

  it('refetches the opened commit files after a reconnect instead of caching the outage answer', async () => {
    const sendRequest = routedSend(() => Promise.resolve(historyResponse('expandable')))
    const client = { sendRequest } as unknown as RpcClient

    await render(client, 'connected')
    await update(client, 'disconnected')
    await openFirstCommit()
    // Opening offline must not cache an outage as an empty file list.
    expect(tree()).toContain('Waiting for desktop...')
    expect(callsOf(sendRequest, 'git.commitCompare')).toHaveLength(0)

    await update(client, 'connected')
    expect(sendRequest).toHaveBeenCalledWith('git.commitCompare', {
      worktree: 'id:wt-1',
      commitId: 'commit-1'
    })
    expect(tree()).toContain('app.ts')
  })

  it.each(['refusal', 'transport', 'malformed'])(
    'shows a retryable %s instead of claiming the commit has no changes',
    async (failure) => {
      let attempts = 0
      const client = createFakeRpcClient()
      client.sendRequest = routedSend(
        () => Promise.resolve(historyResponse('expandable')),
        async () => {
          attempts += 1
          if (attempts > 1) {
            return compareResponse
          }
          if (failure === 'transport') {
            throw new Error('Connection lost')
          }
          if (failure === 'malformed') {
            return { id: 'compare', ok: true, result: {} }
          }
          return {
            id: 'compare',
            ok: false,
            error: { code: 'runtime_error', message: 'Unable to read commit' }
          }
        }
      )
      await render(client, 'connected')
      await openFirstCommit()
      expect(tree()).not.toContain('No file changes')
      expect(tree()).not.toContain('ActivityIndicator')
      const retry = renderer?.root.findAll(
        (node) =>
          String(node.type) === 'Pressable' &&
          node.props.accessibilityLabel === 'Retry commit files'
      )[0]
      expect(retry).toBeDefined()
      await act(async () => {
        retry?.props.onPress()
        await settle()
      })
      expect(tree()).toContain('app.ts')
      expect(tree()).not.toContain('Retry commit files')
    }
  )

  it('keeps previously loaded files when their reconnect refresh is refused', async () => {
    let attempts = 0
    const client = createFakeRpcClient()
    client.sendRequest = routedSend(
      () => Promise.resolve(historyResponse('expandable')),
      async () => {
        attempts += 1
        return attempts === 1
          ? compareResponse
          : {
              id: 'compare',
              ok: false,
              error: { code: 'runtime_error', message: 'Commit refresh failed' }
            }
      }
    )
    await render(client, 'connected')
    await openFirstCommit()
    await update(client, 'reconnecting')
    await update(client, 'connected')
    expect(tree()).toContain('app.ts')
    expect(tree()).not.toContain('No file changes')
  })

  it('lets Back close an open commit before it leaves Source Control', async () => {
    const client = createFakeRpcClient()
    client.sendRequest = routedSend(() => Promise.resolve(historyResponse('expandable')))
    await render(client, 'connected')
    expect(backClaim.current).toBeNull()

    await openFirstCommit()
    expect(tree()).toContain('app.ts')
    let consumed = false
    await act(async () => {
      consumed = backClaim.current?.() ?? false
      await settle()
    })
    expect(consumed).toBe(true)
    expect(tree()).not.toContain('app.ts')
    expect(backClaim.current).toBeNull()
  })

  describe('Retry while the host is unreachable', () => {
    function retryControls() {
      return (
        renderer?.root.findAll(
          (node) =>
            String(node.type) === 'Pressable' &&
            node.findAll((child) => child.props.children === 'Reconnect').length > 0
        ) ?? []
      )
    }

    async function renderUnreachable(): Promise<void> {
      await act(async () => {
        renderer = create(listElement(null, 'reconnecting'))
        await Promise.resolve()
      })
    }

    afterEach(() => {
      transport.forceReconnect = () => Promise.resolve()
    })

    it('is absent on the page, where nothing can re-dial', async () => {
      transport.forceReconnect = null
      await renderUnreachable()
      expect(tree()).toContain('Waiting for desktop')
      expect(retryControls()).toHaveLength(0)
    })

    it('still renders natively and re-dials this host', async () => {
      const forceReconnect = vi.fn(() => Promise.resolve())
      transport.forceReconnect = forceReconnect
      await renderUnreachable()
      await act(async () => {
        retryControls()[0]?.props.onPress()
      })
      expect(forceReconnect.mock.calls).toEqual([['host-1']])
    })

    it('loads again when the shell reconnects, which is what the missing Retry relies on', async () => {
      transport.forceReconnect = null
      await renderUnreachable()
      expect(retryControls()).toHaveLength(0)
      const client = createFakeRpcClient()
      await update(client, 'connected')
      // The load opens with the branch's base lookup, so any request here means it started.
      expect(client.requests).not.toHaveLength(0)
    })
  })
})
