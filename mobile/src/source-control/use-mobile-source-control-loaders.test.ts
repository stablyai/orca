import { createElement } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'
import { prefetchHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
import { gitStatusSummaryQuery, serverGitStatusSummaryQuery } from './mobile-git-status-query'

import {
  documentQueryClient,
  settleQueryNotifications
} from '../test-support/rpc-recording/hook-mount'

// Changes under Review is unfocused; flipping this and re-rendering models the push and the return.
const focus = vi.hoisted(() => ({ current: true }))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (effect: () => (() => void) | void) =>
      React.useEffect(() => (focus.current ? effect() : undefined), [effect, focus.current])
  }
})

// Mock icons reached through screen state; this hook harness renders no UI.
vi.mock('lucide-react-native', () => ({
  ArrowDown: vi.fn(),
  ArrowDownUp: vi.fn(),
  ArrowUp: vi.fn(),
  Check: vi.fn(),
  CloudUpload: vi.fn(),
  GitBranch: vi.fn(),
  GitPullRequestArrow: vi.fn(),
  History: vi.fn(),
  RefreshCw: vi.fn()
}))

// Control settlement order explicitly to test latest-attempt publication, render-time scope retirement and superseded request suppression.

const WORKTREE = 'repo42::/p'
const IDENTITY = `host-1:${WORKTREE}`

type PendingCall = { method: string; params: unknown; settle: (reply: RpcResponse) => void }

function success(result: unknown): RpcResponse {
  return { id: 'call', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

const STATUS_REPLY = success({
  branch: 'feature',
  head: 'head-oid',
  entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged', added: 4, removed: 1 }],
  upstreamStatus: { hasUpstream: true, ahead: 1, behind: 0, upstreamName: 'origin/feature' }
})

const REPO_LIST_REPLY = success({ repos: [] })

function worktreeReply(baseRef: string): RpcResponse {
  return success({ worktree: { baseRef } })
}

function compareReply(baseRef: string): RpcResponse {
  return success({
    summary: {
      baseRef,
      baseOid: 'base-oid',
      compareRef: 'feature',
      headOid: 'head-oid',
      mergeBase: 'merge-base',
      changedFiles: 1,
      status: 'ready'
    },
    entries: [{ path: 'src/app.ts', status: 'modified', added: 2, removed: 1 }]
  })
}

function fakeClient(calls: PendingCall[]): RpcClient {
  const sendRequest = (method: string, params?: unknown): Promise<RpcResponse> =>
    new Promise<RpcResponse>((resolve) => {
      calls.push({ method, params, settle: resolve })
    })
  return stubRpcClient({ sendRequest })
}

async function settleOldest(
  calls: PendingCall[],
  method: string,
  reply: RpcResponse
): Promise<void> {
  const index = calls.findIndex((call) => call.method === method)
  if (index === -1) {
    throw new Error(`The schedule expected a pending ${method}`)
  }
  const [call] = calls.splice(index, 1)
  await act(async () => call.settle(reply))
  await settleQueryNotifications()
}

async function settleCompare(calls: PendingCall[], baseRef: string): Promise<void> {
  const index = calls.findIndex(
    (call) =>
      call.method === 'git.branchCompare' &&
      typeof call.params === 'object' &&
      call.params !== null &&
      'baseRef' in call.params &&
      call.params.baseRef === baseRef
  )
  if (index === -1) {
    throw new Error(`The schedule expected a pending compare against ${baseRef}`)
  }
  const [call] = calls.splice(index, 1)
  await act(async () => call.settle(compareReply(baseRef)))
  await settleQueryNotifications()
}

async function settleBaseRefLookup(calls: PendingCall[], baseRef: string): Promise<void> {
  await settleOldest(calls, 'worktree.show', worktreeReply(baseRef))
  await settleOldest(calls, 'repo.list', REPO_LIST_REPLY)
}

// Stable callbacks keep the mount effect from issuing extra loads that would obscure the tested schedule.
const IGNORE_ACTION_ERROR = (): void => {}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `setRootRef` compares the node against null and returns; it reads no member of it.

describe('useMobileSourceControlLoaders branch compare', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  type Loaders = ReturnType<typeof useMobileSourceControlLoaders>

  async function mount(
    client: RpcClient,
    read: { loaders: Loaders | null }
  ): Promise<(identityKey: string, worktreeId: string) => Promise<void>> {
    function Harness(props: { identityKey: string; worktreeId: string }): null {
      read.loaders = useMobileSourceControlLoaders({
        hostId: 'host-1',
        client,
        connState: 'connected',
        statusIdentityKey: props.identityKey,
        worktreeId: props.worktreeId,
        setActionError: IGNORE_ACTION_ERROR
      })
      return null
    }
    const queries = documentQueryClient()
    const render = (props: { identityKey: string; worktreeId: string }) =>
      queries.wrap(createElement(Harness, props))
    await act(async () => {
      renderer = create(render({ identityKey: IDENTITY, worktreeId: WORKTREE }))
    })
    return async (identityKey, worktreeId) => {
      await act(async () => {
        renderer?.update(render({ identityKey, worktreeId }))
      })
    }
  }

  it('shows the compare again at once after switching away and back while the status read is still fresh', async () => {
    const calls: PendingCall[] = []
    const read: { loaders: Loaders | null } = { loaders: null }
    const rerender = await mount(fakeClient(calls), read)

    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleBaseRefLookup(calls, 'origin/dev')
    await settleCompare(calls, 'origin/dev')
    expect(read.loaders?.branchCompareState.kind).toBe('ready')

    // The other worktree's status never lands, so nothing compares in between.
    await rerender('host-1:repo42::/other', 'repo42::/other')
    await rerender(IDENTITY, WORKTREE)
    expect(read.loaders?.branchCompareState.kind).toBe('ready')
  })
})

describe('useMobileSourceControlLoaders status summary', () => {
  let renderer: ReactTestRenderer | null = null
  const queries = documentQueryClient()

  afterEach(async () => {
    act(() => renderer?.unmount())
    renderer = null
    await queries.end()
    vi.useRealTimers()
  })

  function statusReply(branch: string): RpcResponse {
    return success({ branch, head: `${branch}-oid`, entries: [] })
  }

  it("hands each status read to the folder list's summary of the same worktree, and only that one", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const calls: PendingCall[] = []
    const client = fakeClient(calls)
    const read: { loaders: ReturnType<typeof useMobileSourceControlLoaders> | null } = {
      loaders: null
    }
    let queryClient: QueryClient | null = null
    function Harness(): null {
      queryClient = useQueryClient()
      read.loaders = useMobileSourceControlLoaders({
        hostId: 'host-1',
        client,
        connState: 'connected',
        statusIdentityKey: IDENTITY,
        worktreeId: WORKTREE,
        setActionError: IGNORE_ACTION_ERROR
      })
      return null
    }
    await act(async () => {
      renderer = create(queries.wrap(createElement(Harness)))
    })
    const local = { exec: 'local' as const, worktree: WORKTREE }
    const summaryKey = hostQueryKey('host-1', gitStatusSummaryQuery.family, local, {})
    // The same worktree id on a relayed server keeps its own summary.
    const elsewhere = { exec: 'runtime:env-1' as const, worktree: WORKTREE }
    const elsewhereKey = hostQueryKey('host-1', serverGitStatusSummaryQuery.family, elsewhere, {})
    const elsewhereData = { kind: 'unavailable' as const }
    queryClient!.setQueryData(elsewhereKey, elsewhereData)
    // The folder list's summary read is out when the screen's own read lands.
    void prefetchHostQuery(
      queryClient!,
      gitStatusSummaryQuery,
      { hostId: 'host-1', client },
      local,
      {}
    )
    // Summary reads skip line stats.
    const summaryRead = calls.findIndex(
      (call) =>
        call.method === 'git.status' &&
        (call.params as { includeLineStats?: boolean }).includeLineStats === false
    )
    const [stale] = calls.splice(summaryRead, 1)

    // Landing just after the screen's read, the earlier summary read must not undo it.
    const opened = calls.findIndex((call) => call.method === 'git.status')
    const [screenRead] = calls.splice(opened, 1)
    await act(async () => {
      screenRead.settle(statusReply('opened'))
      for (let i = 0; i < 20; i++) {
        await Promise.resolve()
      }
      vi.setSystemTime(Date.now() + 1)
      stale.settle(statusReply('before'))
    })
    await settleQueryNotifications()
    expect(queryClient!.getQueryData(summaryKey)).toMatchObject({ status: { branch: 'opened' } })

    // An action's forced reread.
    const reread = read.loaders!.loadStatus({ force: true })
    await settleQueryNotifications()
    await settleOldest(calls, 'git.status', statusReply('after'))
    await act(async () => {
      await reread
    })
    await settleQueryNotifications()
    expect(queryClient!.getQueryData(summaryKey)).toMatchObject({ status: { branch: 'after' } })
    expect(queryClient!.getQueryData(elsewhereKey)).toBe(elsewhereData)
    expect(calls.filter((call) => call.method === 'git.status')).toHaveLength(0)
  })
})
