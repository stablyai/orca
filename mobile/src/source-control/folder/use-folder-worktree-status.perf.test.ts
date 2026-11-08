import { createElement, Fragment } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEventStreamMessage } from '../../../../src/shared/runtime-client-events'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../../test-support/rpc-recording/hook-mount'
import { useFolderWorktreeStatus } from './use-folder-worktree-status'

const STATUS = { branch: 'feature', entries: [] }

function countingClient() {
  const reads: string[] = []
  let emit: (event: RuntimeClientEventStreamMessage) => void = () => {}
  const client: RpcClient = stubRpcClient({
    getLastConnectedAt: () => 1,
    sendRequest: async (method, params) => {
      if (method === 'git.status') {
        reads.push((params as { worktree: string }).worktree)
      }
      return { id: 'call', ok: true, result: STATUS, _meta: { runtimeId: 'runtime-1' } }
    },
    subscribe: (_method, _params, onEvent) => {
      emit = (event) => onEvent(event)
      return () => {}
    }
  })
  return { client, reads, emit: (event: RuntimeClientEventStreamMessage) => emit(event) }
}

let renderer: ReactTestRenderer | null = null
const queries = documentQueryClient()

afterEach(async () => {
  act(() => renderer?.unmount())
  renderer = null
  await queries.end()
  vi.useRealTimers()
})

function Row(props: { client: RpcClient; worktreeId: string; subscribed: boolean }): null {
  useFolderWorktreeStatus({
    hostId: 'host-1',
    client: props.client,
    routeHost: undefined,
    worktreeId: props.worktreeId,
    subscribed: props.subscribed,
    refreshers: REFRESHERS
  })
  return null
}
const REFRESHERS = new Set<() => void>()

/** One folder's N attached worktrees in repo-a and N in repo-b. */
async function mountFolder(n: number, client: RpcClient) {
  const ids = ['repo-a', 'repo-b'].flatMap((repo) =>
    Array.from({ length: n }, (_, i) => `${repo}::/w${i}`)
  )
  const render = (subscribed: boolean) =>
    queries.wrap(
      createElement(
        Fragment,
        null,
        ids.map((worktreeId) =>
          createElement(Row, { key: worktreeId, client, worktreeId, subscribed })
        )
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

describe.each([10, 100])('folder Source Control rows at N=%i', (n) => {
  it('read git.status once per worktree a signal names, and not at all while hidden', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const host = countingClient()
    const setSubscribed = await mountFolder(n, host.client)
    host.emit({ type: 'ready' } as RuntimeClientEventStreamMessage)
    await settleQueryNotifications()
    expect(host.reads).toHaveLength(2 * n)

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
    expect(host.reads).toEqual(['id:repo-a::/w0'])

    await setSubscribed(false)
    host.reads.length = 0
    passSignalFloor()
    await act(async () => host.emit({ type: 'gitStatusChanged', repoId: 'repo-a' }))
    await settleQueryNotifications()
    expect(host.reads).toHaveLength(0)
  })
})
