import { createElement, Fragment } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../src/shared/execution-host'
import type { RuntimeClientEventStreamMessage } from '../../../../src/shared/runtime-client-events'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../../test-support/rpc-recording/hook-mount'
import { hostQueryKey } from '../../query/host-query-key'
import {
  publishGitStatusSummary,
  serverGitStatusSummaryQuery,
  type GitStatusRead
} from '../mobile-git-status-query'
import { useFolderWorktreeStatus } from './use-folder-worktree-status'

const STATUS = { branch: 'feature', entries: [] }

type StatusRead = { worktree: string; includeLineStats?: boolean }

function isStatusRead(params: unknown): params is StatusRead {
  return typeof params === 'object' && params !== null && 'worktree' in params
}

const runtimeHost = (environmentId: string): ExecutionHostId => `runtime:${environmentId}`
const READY: RuntimeClientEventStreamMessage = { type: 'ready', subscriptionId: 'sub-1' }

function countingClient() {
  const reads: StatusRead[] = []
  let eventStreams = 0
  let emit: (event: RuntimeClientEventStreamMessage) => void = () => {}
  const client: RpcClient = stubRpcClient({
    getLastConnectedAt: () => 1,
    sendRequest: async (method, params) => {
      if (method === 'git.status') {
        if (isStatusRead(params)) {
          reads.push(params)
        }
      }
      return { id: 'call', ok: true, result: STATUS, _meta: { runtimeId: 'runtime-1' } }
    },
    subscribe: (method, _params, onEvent) => {
      if (method === 'runtime.clientEvents.subscribe') {
        eventStreams += 1
        emit = (event) => onEvent(event)
      }
      return () => {}
    }
  })
  return {
    client,
    reads,
    eventStreams: () => eventStreams,
    emit: (event: RuntimeClientEventStreamMessage) => emit(event)
  }
}

let renderer: ReactTestRenderer | null = null
const queries = documentQueryClient()

afterEach(async () => {
  act(() => renderer?.unmount())
  renderer = null
  await queries.end()
  vi.useRealTimers()
})

const REFRESHERS = new Set<() => void>()
const shown = new Map<string, { data: GitStatusRead | undefined; updatedAt: number }>()
let queryClient: QueryClient | null = null
const rowKey = (row: RowSpec) => `${row.routeHost ?? 'local'}|${row.worktreeId}`

function Row(props: {
  client: RpcClient
  worktreeId: string
  routeHost: ExecutionHostId | undefined
  subscribed: boolean
}): null {
  queryClient = useQueryClient()
  const status = useFolderWorktreeStatus({
    hostId: 'host-1',
    client: props.client,
    routeHost: props.routeHost,
    worktreeId: props.worktreeId,
    subscribed: props.subscribed,
    refreshers: REFRESHERS
  })
  shown.set(rowKey(props), { data: status.data, updatedAt: status.dataUpdatedAt })
  return null
}

type RowSpec = { worktreeId: string; routeHost: ExecutionHostId | undefined }

/** One folder's attached worktrees: N in repo-a and N in repo-b on the desktop, N spread over S relayed servers. */
function folderRows(n: number, servers: number): RowSpec[] {
  const local = ['repo-a', 'repo-b'].flatMap((repo) =>
    Array.from({ length: n }, (_, i) => ({ worktreeId: `${repo}::/w${i}`, routeHost: undefined }))
  )
  const relayed = Array.from({ length: n }, (_, i) => ({
    worktreeId: `repo-s::/w${i}`,
    routeHost: runtimeHost(`env-${i % servers}`)
  }))
  return [...local, ...relayed]
}

async function mountFolder(rows: RowSpec[], client: RpcClient) {
  const render = (subscribed: boolean) =>
    queries.wrap(
      createElement(
        Fragment,
        null,
        rows.map((row) => createElement(Row, { key: rowKey(row), client, ...row, subscribed }))
      )
    )
  await act(async () => {
    renderer = create(render(true))
  })
  await settleQueryNotifications()
  return async (subscribed: boolean) => {
    await act(async () => renderer?.update(render(subscribed)))
    await settleQueryNotifications()
  }
}

// Past every read's one-second signal floor, so each signal reads at once.
function passSignalFloor(): void {
  vi.setSystemTime(Date.now() + 5_000)
}

describe.each([
  { n: 10, servers: 3 },
  { n: 100, servers: 30 }
])('folder Source Control rows at N=$n over $servers servers', ({ n, servers }) => {
  it('read each status once without line stats, on one desktop event stream', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const host = countingClient()
    await mountFolder(folderRows(n, servers), host.client)
    host.emit(READY)
    await settleQueryNotifications()

    expect(host.reads).toHaveLength(3 * n)
    expect(host.reads.every((read) => read.includeLineStats === false)).toBe(true)
    // Relayed servers' statuses get no desktop signal, so they open no event stream of their own.
    expect(host.eventStreams()).toBe(1)
  })

  it('read once per worktree a signal names, and not at all while hidden', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const host = countingClient()
    const setSubscribed = await mountFolder(folderRows(n, servers), host.client)
    host.emit(READY)
    await settleQueryNotifications()

    host.reads.length = 0
    passSignalFloor()
    await act(async () => host.emit({ type: 'gitStatusChanged', repoId: 'repo-a' }))
    await settleQueryNotifications()
    expect(host.reads).toHaveLength(n)

    host.reads.length = 0
    passSignalFloor()
    await act(async () =>
      host.emit({ type: 'gitStatusChanged', repoId: 'repo-a', worktreeIds: ['repo-a::/w0'] })
    )
    await settleQueryNotifications()
    expect(host.reads.map((read) => read.worktree)).toEqual(['id:repo-a::/w0'])

    await setSubscribed(false)
    host.reads.length = 0
    passSignalFloor()
    await act(async () => host.emit({ type: 'gitStatusChanged', repoId: 'repo-a' }))
    await settleQueryNotifications()
    expect(host.reads).toHaveLength(0)
  })

  it("shows a child's detailed read on Back with no read of its own", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const host = countingClient()
    // The same worktree id on another server and on the desktop must keep their own summaries.
    const opened: RowSpec = { worktreeId: 'repo-s::/w0', routeHost: 'runtime:env-0' }
    const rows = [
      ...folderRows(n, servers),
      { worktreeId: 'repo-s::/w0', routeHost: runtimeHost('env-x') },
      { worktreeId: 'repo-s::/w0', routeHost: undefined }
    ]
    const setSubscribed = await mountFolder(rows, host.client)
    const before = new Map(shown)
    const listed = before.get(rowKey(opened))!
    if (listed.data?.kind !== 'ready') {
      throw new Error('summary not read')
    }

    // The child opens over the list, commits, and its forced reread lands.
    await setSubscribed(false)
    host.reads.length = 0
    vi.setSystemTime(Date.now() + 1_000)
    const after: GitStatusRead = {
      kind: 'ready',
      status: { ...listed.data.status, branch: 'after' }
    }
    const target = { exec: opened.routeHost!, worktree: opened.worktreeId }
    await act(() =>
      publishGitStatusSummary(queryClient!, 'host-1', target, after, Date.now(), true)
    )
    // A detailed read older than the summary changes nothing.
    await act(() =>
      publishGitStatusSummary(
        queryClient!,
        'host-1',
        target,
        listed.data!,
        listed.updatedAt - 1,
        true
      )
    )

    // Back within three seconds, then well past them with no focus or signal.
    vi.setSystemTime(Date.now() + 1_000)
    await setSubscribed(true)
    vi.setSystemTime(Date.now() + 10_000)
    await setSubscribed(true)
    expect(host.reads).toHaveLength(0)
    expect(shown.get(rowKey(opened))?.data).toEqual(after)
    const changed = rows.filter(
      (row) => shown.get(rowKey(row))?.data !== before.get(rowKey(row))?.data
    )
    expect(changed).toEqual([opened])
  })

  it("keeps a summary's newer failure over an older detailed read", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const host = countingClient()
    const opened: RowSpec = { worktreeId: 'repo-s::/w0', routeHost: 'runtime:env-0' }
    await mountFolder(folderRows(n, servers), host.client)
    const listed = shown.get(rowKey(opened))!
    const target = { exec: opened.routeHost!, worktree: opened.worktreeId }
    const key = hostQueryKey('host-1', serverGitStatusSummaryQuery.family, target, {})
    const cachedDetailAt = Date.now() + 1_000
    vi.setSystemTime(cachedDetailAt + 1_000)
    const failure = new Error('status read failed')
    await act(async () =>
      queryClient!
        .getQueryCache()
        .find({ queryKey: key, exact: true })!
        .setState({ status: 'error', error: failure, errorUpdatedAt: Date.now() })
    )

    await act(() =>
      publishGitStatusSummary(queryClient!, 'host-1', target, listed.data!, cachedDetailAt, true)
    )
    expect(queryClient!.getQueryState(key)?.error).toBe(failure)
  })
})
