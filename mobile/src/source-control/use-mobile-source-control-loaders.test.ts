import { createElement } from 'react'
import { hashKey, QueryClientProvider, type QueryClient } from '@tanstack/react-query'

import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'
import { prefetchHostQuery } from '../query/host-query'
import { hostQueryKey } from '../query/host-query-key'
import {
  gitStatusQuery,
  gitStatusSummaryQuery,
  serverGitStatusSummaryQuery,
  type GitStatusRead
} from './mobile-git-status-query'
import { gitStatusHostPayloadSchema } from './git-status-reply-schema'
import { createOrcaQueryClient } from '../query/orca-query-client'
import { createHostQueryPersistence } from '../query/host-query-persistence'
import type { OrcaQueryStoreBackend } from '../device-store/query-storage'

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
  let queryClient: QueryClient | null = null

  afterEach(async () => {
    act(() => renderer?.unmount())
    renderer = null
    await queryClient?.cancelQueries()
    queryClient?.clear()
    queryClient = null
    vi.useRealTimers()
  })

  const local = { exec: 'local' as const, worktree: WORKTREE }
  const summaryKey = hostQueryKey('host-1', gitStatusSummaryQuery.family, local, {})
  const detailKey = hostQueryKey('host-1', gitStatusQuery.family, local, {})

  function statusReply(branch: string): RpcResponse {
    return success({ branch, head: `${branch}-oid`, entries: [] })
  }

  function readOf(branch: string): GitStatusRead {
    return {
      kind: 'ready',
      status: gitStatusHostPayloadSchema.parse({ branch, head: `${branch}-oid`, entries: [] })
    }
  }

  // Summary reads skip line stats; the screen's own read asks for them.
  function isSummaryRead(params: unknown): boolean {
    return (
      typeof params === 'object' &&
      params !== null &&
      'includeLineStats' in params &&
      params.includeLineStats === false
    )
  }

  function takeRead(calls: PendingCall[], summary: boolean): PendingCall {
    const index = calls.findIndex(
      (call) => call.method === 'git.status' && isSummaryRead(call.params) === summary
    )
    if (index === -1) {
      throw new Error(`The schedule expected a pending ${summary ? 'summary' : 'status'} read`)
    }
    return calls.splice(index, 1)[0]
  }

  function setup(calls: PendingCall[]) {
    const client = fakeClient(calls)
    const documentClient = createOrcaQueryClient()
    queryClient = documentClient
    // Successful writes to each summary entry: its own reads and publications.
    const summaryWrites = new Map<string, number>()
    documentClient.getQueryCache().subscribe((event) => {
      const family = event.query.queryKey[2]
      if (
        event.type === 'updated' &&
        event.action.type === 'success' &&
        typeof family === 'string' &&
        family.startsWith('git.statusSummary')
      ) {
        summaryWrites.set(
          event.query.queryHash,
          (summaryWrites.get(event.query.queryHash) ?? 0) + 1
        )
      }
    })
    const read: { loaders: ReturnType<typeof useMobileSourceControlLoaders> | null } = {
      loaders: null
    }
    function Harness(): null {
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
    return {
      client,
      queryClient: documentClient,
      read,
      writesTo: (key: readonly unknown[]) => summaryWrites.get(hashKey(key)) ?? 0,
      clearWrites: () => summaryWrites.clear(),
      readSummary: () =>
        void prefetchHostQuery(
          documentClient,
          gitStatusSummaryQuery,
          { hostId: 'host-1', client },
          local,
          {}
        ),
      mount: async () => {
        await act(async () => {
          renderer = create(
            createElement(QueryClientProvider, { client: documentClient }, createElement(Harness))
          )
        })
      }
    }
  }

  it('hands each accepted status read to the matching summary once, over an earlier summary read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const calls: PendingCall[] = []
    const child = setup(calls)
    // The same worktree id on a relayed server keeps its own summary.
    const elsewhereKey = hostQueryKey(
      'host-1',
      serverGitStatusSummaryQuery.family,
      { exec: 'runtime:env-1', worktree: WORKTREE },
      {}
    )
    const elsewhereData = { kind: 'unavailable' as const }
    child.queryClient.setQueryData(elsewhereKey, elsewhereData)
    child.clearWrites()
    await child.mount()
    child.readSummary()
    const stale = takeRead(calls, true)
    const screenRead = takeRead(calls, false)

    // Landing just after the screen's read, the earlier summary read must not undo it.
    await act(async () => {
      screenRead.settle(statusReply('opened'))
      for (let i = 0; i < 20; i++) {
        await Promise.resolve()
      }
      vi.setSystemTime(Date.now() + 1)
      stale.settle(statusReply('before'))
    })
    await settleQueryNotifications()
    expect(child.queryClient.getQueryData(summaryKey)).toMatchObject({
      status: { branch: 'opened' }
    })
    expect(child.writesTo(summaryKey)).toBe(1)

    // An action's forced reread.
    const reread = child.read.loaders!.loadStatus({ force: true })
    await settleQueryNotifications()
    await act(async () => takeRead(calls, false).settle(statusReply('after')))
    await act(async () => {
      await reread
    })
    await settleQueryNotifications()
    expect(child.queryClient.getQueryData(summaryKey)).toMatchObject({
      status: { branch: 'after' }
    })
    expect(child.writesTo(summaryKey)).toBe(2)
    expect(child.queryClient.getQueryData(elsewhereKey)).toBe(elsewhereData)
    expect(child.writesTo(elsewhereKey)).toBe(0)
    expect(calls.filter((call) => call.method === 'git.status')).toHaveLength(0)
  })

  // Summary read at 100, detail cached at 200, child opened at 400.
  async function cachedDetailOpened(refreshAt300: boolean) {
    vi.useFakeTimers({ toFake: ['Date'], now: 100 })
    const calls: PendingCall[] = []
    const child = setup(calls)
    child.queryClient.setQueryData(summaryKey, readOf('first'), { updatedAt: 100 })
    vi.setSystemTime(200)
    child.queryClient.setQueryData(detailKey, readOf('cached'), { updatedAt: 200 })
    vi.setSystemTime(300)
    if (refreshAt300) {
      await child.queryClient.invalidateQueries({ queryKey: summaryKey }, { cancelRefetch: false })
      child.readSummary()
    }
    child.clearWrites()
    vi.setSystemTime(400)
    await child.mount()
    await settleQueryNotifications()
    return { calls, child }
  }

  it('leaves a summary read out to answer when the child opens over an older cached read', async () => {
    const { calls, child } = await cachedDetailOpened(true)
    expect(child.writesTo(summaryKey)).toBe(0)
    await act(async () => takeRead(calls, true).settle(statusReply('refresh')))
    await settleQueryNotifications()
    expect(child.queryClient.getQueryData(summaryKey)).toMatchObject({
      status: { branch: 'refresh' }
    })
  })

  it('catches an idle older summary up to the cached read once, keeping its time', async () => {
    const { calls, child } = await cachedDetailOpened(false)
    expect(child.writesTo(summaryKey)).toBe(1)
    expect(child.queryClient.getQueryData(summaryKey)).toEqual(readOf('cached'))
    expect(child.queryClient.getQueryState(summaryKey)?.dataUpdatedAt).toBe(200)
    expect(calls.filter((call) => call.method === 'git.status')).toHaveLength(0)
  })

  it("never hands an earlier launch's status to the summary, nor cancels its live read", async () => {
    const store = memoryStore()
    const earlier = createOrcaQueryClient()
    const earlierPersistence = createHostQueryPersistence(earlier, store.backend)
    earlier.getQueryCache().build(earlier, {
      queryKey: detailKey,
      meta: { persist: gitStatusQuery.persist }
    })
    earlier.setQueryData(detailKey, readOf('saved'), { updatedAt: Date.now() - 86_400_000 })
    await settleQueryNotifications()
    await earlierPersistence.flush()
    expect(store.rows.size).toBe(1)
    earlier.clear()

    const calls: PendingCall[] = []
    const child = setup(calls)
    createHostQueryPersistence(child.queryClient, store.backend)
    child.readSummary()
    const release = store.holdReads()
    await child.mount()
    release()
    await settleQueryNotifications()
    expect(child.queryClient.getQueryData(detailKey)).toEqual(readOf('saved'))
    expect(child.writesTo(summaryKey)).toBe(0)

    await act(async () => takeRead(calls, true).settle(statusReply('live')))
    await settleQueryNotifications()
    expect(child.queryClient.getQueryData(summaryKey)).toMatchObject({ status: { branch: 'live' } })

    await act(async () => takeRead(calls, false).settle(statusReply('newer')))
    await settleQueryNotifications()
    expect(child.queryClient.getQueryData(summaryKey)).toMatchObject({
      status: { branch: 'newer' }
    })
    expect(child.writesTo(summaryKey)).toBe(2)
  })
})

function memoryStore() {
  const rows = new Map<string, string>()
  let readGate: Promise<void> = Promise.resolve()
  const backend: OrcaQueryStoreBackend = {
    hostId: 'host-1',
    read: async (keys) => {
      await readGate
      return { status: 'ok', values: keys.map((storeKey) => rows.get(storeKey) ?? null) }
    },
    write: async (ops) => {
      for (const op of ops) {
        if (op.value === null) {
          rows.delete(op.key)
        } else {
          rows.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  }
  return {
    backend,
    rows,
    holdReads: () => {
      let release = (): void => {}
      readGate = new Promise((resolve) => {
        release = resolve
      })
      return release
    }
  }
}
