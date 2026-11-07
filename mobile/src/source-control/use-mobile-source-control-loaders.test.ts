import { createElement } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileSourceControlLoaders } from './use-mobile-source-control-loaders'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { createOrcaQueryClient } from '../query/orca-query-client'
import {
  documentQueryClient,
  settleQueryNotifications
} from '../test-support/rpc-recording/hook-mount'

vi.mock('expo-router', async () => {
  const React = await import('react')
  return { useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]) }
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
}

async function settleBaseRefLookup(calls: PendingCall[], baseRef: string): Promise<void> {
  await settleOldest(calls, 'worktree.show', worktreeReply(baseRef))
  await settleOldest(calls, 'repo.list', REPO_LIST_REPLY)
}

function pendingCount(calls: PendingCall[], method: string): number {
  return calls.filter((call) => call.method === method).length
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

  it('lets the newest compare publish and refuses the one it superseded', async () => {
    const calls: PendingCall[] = []
    const read: { loaders: Loaders | null } = { loaders: null }
    await mount(fakeClient(calls), read)

    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleBaseRefLookup(calls, 'origin/dev')
    expect(pendingCount(calls, 'git.branchCompare')).toBe(1)

    // Force status to start a second compare; an unforced load would join the pending status.
    await act(async () => {
      void read.loaders?.loadStatus({ force: true })
    })
    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleBaseRefLookup(calls, 'origin/main')
    expect(pendingCount(calls, 'git.branchCompare')).toBe(2)

    await settleCompare(calls, 'origin/main')
    expect(read.loaders?.branchCompareState).toEqual({
      kind: 'ready',
      result: expect.objectContaining({
        summary: expect.objectContaining({ baseRef: 'origin/main' })
      })
    })

    await settleCompare(calls, 'origin/dev')
    expect(read.loaders?.branchCompareState).toEqual({
      kind: 'ready',
      result: expect.objectContaining({
        summary: expect.objectContaining({ baseRef: 'origin/main' })
      })
    })
  })

  it('refuses a compare whose route identity moved while it was out', async () => {
    const calls: PendingCall[] = []
    const read: { loaders: Loaders | null } = { loaders: null }
    const rerender = await mount(fakeClient(calls), read)

    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleBaseRefLookup(calls, 'origin/dev')
    expect(pendingCount(calls, 'git.branchCompare')).toBe(1)

    // Switch worktrees while new status is pending, before another compare can supersede the old scope.
    await rerender('host-1:repo42::/other', 'repo42::/other')
    expect(read.loaders?.branchCompareState).toEqual({ kind: 'idle' })

    await settleCompare(calls, 'origin/dev')
    expect(read.loaders?.branchCompareState).toEqual({ kind: 'idle' })
  })
})

describe('useMobileSourceControlLoaders action error', () => {
  it('leaves the action error to the reads that actions and refreshes make', async () => {
    const calls: PendingCall[] = []
    const actionErrors: (string | null)[] = []
    const queryClient = createOrcaQueryClient()
    // Stable, as the screen's state setter is; a new identity would read as a refocus.
    const recordActionError = (message: string | null): void => {
      actionErrors.push(message)
    }
    function Harness(): null {
      useMobileSourceControlLoaders({
        hostId: 'host-1',
        client: fakeClient(calls),
        connState: 'connected',
        statusIdentityKey: IDENTITY,
        worktreeId: WORKTREE,
        setActionError: recordActionError
      })
      return null
    }
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Harness))
      )
    })
    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleQueryNotifications()

    // An open, foreground or reconnect read can land after an action failed; it must not wipe that error.
    await act(async () => {
      void queryClient.invalidateQueries()
    })
    await settleOldest(calls, 'git.status', STATUS_REPLY)
    await settleQueryNotifications()
    expect(actionErrors).toEqual([])
    act(() => renderer?.unmount())
  })
})
