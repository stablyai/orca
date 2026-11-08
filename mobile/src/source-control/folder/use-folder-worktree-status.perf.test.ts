import { createElement, Fragment } from 'react'
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
import { useFolderWorktreeStatus } from './use-folder-worktree-status'

const STATUS = { branch: 'feature', entries: [] }

type StatusRead = { worktree: string; includeLineStats?: boolean }

function countingClient() {
  const reads: StatusRead[] = []
  let eventStreams = 0
  let emit: (event: RuntimeClientEventStreamMessage) => void = () => {}
  const client: RpcClient = stubRpcClient({
    getLastConnectedAt: () => 1,
    sendRequest: async (method, params) => {
      if (method === 'git.status') {
        reads.push(params as StatusRead)
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

function Row(props: {
  client: RpcClient
  worktreeId: string
  routeHost: ExecutionHostId | undefined
  subscribed: boolean
}): null {
  useFolderWorktreeStatus({
    hostId: 'host-1',
    client: props.client,
    routeHost: props.routeHost,
    worktreeId: props.worktreeId,
    subscribed: props.subscribed,
    refreshers: REFRESHERS
  })
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
    routeHost: `runtime:env-${i % servers}` as ExecutionHostId
  }))
  return [...local, ...relayed]
}

async function mountFolder(rows: RowSpec[], client: RpcClient) {
  const render = (subscribed: boolean) =>
    queries.wrap(
      createElement(
        Fragment,
        null,
        rows.map((row) => createElement(Row, { key: row.worktreeId, client, ...row, subscribed }))
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
    host.emit({ type: 'ready' } as RuntimeClientEventStreamMessage)
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
    host.emit({ type: 'ready' } as RuntimeClientEventStreamMessage)
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
})
