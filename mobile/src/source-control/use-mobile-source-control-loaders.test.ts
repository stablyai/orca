import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { View } from 'react-native'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'

// The screen-state module these loaders share with the panel pulls the icon set in; none of it is
// reachable from a hook that renders nothing.
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

/**
 * What the branch-compare leg now rests on and nothing else held: the owner's commit verdict is the
 * only thing that decides which of two overlapping compares reaches the screen, the render-phase
 * `reset()` is the only thing that retires a compare when the route identity moves, and the owner's
 * currency probe is the only thing that keeps a superseded attempt off the wire. All three are
 * written as explicit settlement orders rather than timers, so each case states its schedule.
 */

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these loaders reach `sendRequest` and nothing else on the client; the owner's scope holds the instance by identity without calling it.
  return { sendRequest } as RpcClient
}

/** Settles the oldest unanswered call for `method`, which is what orders one attempt against another. */
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
}

/** Settles the compare an attempt sent, named by the base ref that attempt resolved. */
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
}

/** Resolves one whole base-ref lookup: the worktree summary and the repo list go out together. */
async function settleBaseRefLookup(calls: PendingCall[], baseRef: string): Promise<void> {
  await settleOldest(calls, 'worktree.show', worktreeReply(baseRef))
  await settleOldest(calls, 'repo.list', REPO_LIST_REPLY)
}

function pendingCount(calls: PendingCall[], method: string): number {
  return calls.filter((call) => call.method === method).length
}

/** Stable across renders: the mount effect keys on the callbacks it was handed, so a fresh closure
 *  per render would re-send the status load and hide the schedule these cases are written in. */
const IGNORE_ACTION_ERROR = (): void => {}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `setRootRef` compares the node against null and returns; it reads no member of it.
const ROOT_NODE = {} as View

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
        client,
        connState: 'connected',
        statusIdentityKey: props.identityKey,
        worktreeId: props.worktreeId,
        setActionError: IGNORE_ACTION_ERROR
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness, { identityKey: IDENTITY, worktreeId: WORKTREE }))
    })
    return async (identityKey, worktreeId) => {
      await act(async () => {
        renderer?.update(createElement(Harness, { identityKey, worktreeId }))
      })
    }
  }

  it('lets the newest compare publish and refuses the one it superseded', async () => {
    const calls: PendingCall[] = []
    const read: { loaders: Loaders | null } = { loaders: null }
    await mount(fakeClient(calls), read)

    // First attempt, taken as far as a compare on the wire.
    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleBaseRefLookup(calls, 'origin/dev')
    expect(pendingCount(calls, 'git.branchCompare')).toBe(1)

    // Second attempt, started while the first compare is still out. A forced status load is how the
    // screen reaches a second compare: the unforced one would join the in-flight status instead.
    await act(async () => {
      void read.loaders?.loadStatus({ force: true })
    })
    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleBaseRefLookup(calls, 'origin/main')
    // Two physical compares, not one: an attempt never shares its predecessor's reply.
    expect(pendingCount(calls, 'git.branchCompare')).toBe(2)

    await settleCompare(calls, 'origin/main')
    expect(read.loaders?.branchCompareState).toEqual({
      kind: 'ready',
      result: expect.objectContaining({
        summary: expect.objectContaining({ baseRef: 'origin/main' })
      })
    })

    // The superseded reply settles last and has nowhere to land.
    await settleCompare(calls, 'origin/dev')
    expect(read.loaders?.branchCompareState).toEqual({
      kind: 'ready',
      result: expect.objectContaining({
        summary: expect.objectContaining({ baseRef: 'origin/main' })
      })
    })
  })

  it('sends no compare for an attempt superseded while it resolved its base ref', async () => {
    const calls: PendingCall[] = []
    const read: { loaders: Loaders | null } = { loaders: null }
    await mount(fakeClient(calls), read)

    // First attempt, stopped mid base-ref lookup: nothing of it has reached `git.branchCompare` yet.
    await settleOldest(calls, 'git.status', STATUS_REPLY)
    expect(pendingCount(calls, 'worktree.show')).toBe(1)

    // Second attempt supersedes it while that lookup is still out.
    await act(async () => {
      void read.loaders?.loadStatus({ force: true })
    })
    await settleOldest(calls, 'git.status', STATUS_REPLY)

    // The superseded attempt resumes with its base ref in hand and stops on the probe. No compare
    // has been settled in this case, so what is pending is everything that was ever sent.
    await settleBaseRefLookup(calls, 'origin/dev')
    expect(pendingCount(calls, 'git.branchCompare')).toBe(0)

    // Exactly one compare on the wire, the live attempt's, which is the request count main sent.
    await settleBaseRefLookup(calls, 'origin/main')
    expect(pendingCount(calls, 'git.branchCompare')).toBe(1)

    await settleCompare(calls, 'origin/main')
    expect(read.loaders?.branchCompareState).toEqual({
      kind: 'ready',
      result: expect.objectContaining({
        summary: expect.objectContaining({ baseRef: 'origin/main' })
      })
    })
  })

  it('sends no compare for an attempt the route detached under', async () => {
    const calls: PendingCall[] = []
    const read: { loaders: Loaders | null } = { loaders: null }
    await mount(fakeClient(calls), read)
    await act(async () => read.loaders?.setRootRef(ROOT_NODE))

    await settleOldest(calls, 'git.status', STATUS_REPLY)
    expect(pendingCount(calls, 'worktree.show')).toBe(1)

    // The route detaches mid base-ref lookup. Dropping the mount latch is not enough on its own:
    // only the detach's `reset()` retires the attempt, and the probe is what reads that.
    await act(async () => read.loaders?.setRootRef(null))

    await settleBaseRefLookup(calls, 'origin/dev')
    expect(pendingCount(calls, 'git.branchCompare')).toBe(0)
  })

  it('refuses a compare whose route identity moved while it was out', async () => {
    const calls: PendingCall[] = []
    const read: { loaders: Loaders | null } = { loaders: null }
    const rerender = await mount(fakeClient(calls), read)

    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleBaseRefLookup(calls, 'origin/dev')
    expect(pendingCount(calls, 'git.branchCompare')).toBe(1)

    // The route is reused for another worktree. Its status load is still out, so no compare has
    // entered the new scope yet: this is the window the identity check used to own.
    await rerender('host-1:repo42::/other', 'repo42::/other')
    expect(read.loaders?.branchCompareState).toEqual({ kind: 'idle' })

    await settleCompare(calls, 'origin/dev')
    expect(read.loaders?.branchCompareState).toEqual({ kind: 'idle' })
  })
})

describe('useMobileSourceControlLoaders status on reconnect', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness(props: { client: RpcClient | null; connState: ConnectionState }): null {
    useMobileSourceControlLoaders({
      client: props.client,
      connState: props.connState,
      statusIdentityKey: IDENTITY,
      worktreeId: WORKTREE,
      setActionError: IGNORE_ACTION_ERROR
    })
    return null
  }

  it('reads status again when the shell reconnects, which is what the missing page Retry relies on', async () => {
    // The page hides the status Retry while unreachable because nothing there re-dials; the read
    // has to come back on its own from the client and state the shell's reconnect delivers.
    await act(async () => {
      renderer = create(createElement(Harness, { client: null, connState: 'reconnecting' }))
    })
    const client = createFakeRpcClient()
    await act(async () => {
      renderer?.update(createElement(Harness, { client, connState: 'connected' }))
    })
    expect(client.requests.map((request) => request.method)).toContain('git.status')
  })
})
