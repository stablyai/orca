import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-sections'
import {
  MOBILE_AGENTS_POLL_INTERVAL_MS,
  MOBILE_AGENTS_WORKTREE_PS_LIMIT,
  createMobileAgentsFetcher,
  getMobileAgentsCenterState,
  type MobileAgentsFetchSnapshot
} from './mobile-agents-screen-state'

describe('mobile agents screen state', () => {
  it('keeps polling and worktree request limits explicit', () => {
    expect(MOBILE_AGENTS_POLL_INTERVAL_MS).toBe(3000)
    expect(MOBILE_AGENTS_WORKTREE_PS_LIMIT).toBe(10000)
  })

  it('describes loading, connecting, and disconnected center states', () => {
    expect(
      getMobileAgentsCenterState({
        loaded: false,
        connectionState: 'connected',
        isErrorVerdict: false,
        showConnecting: false,
        visibleGroupCount: 0,
        hasActiveFilter: false,
        error: null,
        verdictLabel: 'Offline'
      })
    ).toEqual({ kind: 'loading', message: 'Loading agents...' })

    expect(
      getMobileAgentsCenterState({
        loaded: false,
        connectionState: 'connecting',
        isErrorVerdict: false,
        showConnecting: true,
        visibleGroupCount: 0,
        hasActiveFilter: false,
        error: null,
        verdictLabel: 'Connecting'
      })
    ).toEqual({ kind: 'connecting', message: 'Connecting to host...' })

    expect(
      getMobileAgentsCenterState({
        loaded: false,
        connectionState: 'disconnected',
        isErrorVerdict: true,
        showConnecting: false,
        visibleGroupCount: 0,
        hasActiveFilter: false,
        error: 'Socket closed',
        verdictLabel: 'Offline'
      })
    ).toEqual({ kind: 'error', message: 'Socket closed', showReconnect: true })
  })

  it('keeps an error-only first load from also claiming empty activity', () => {
    expect(
      getMobileAgentsCenterState({
        loaded: true,
        connectionState: 'connected',
        isErrorVerdict: false,
        showConnecting: false,
        visibleGroupCount: 0,
        hasActiveFilter: false,
        error: 'worktree.ps failed',
        verdictLabel: 'Connected'
      })
    ).toEqual({ kind: 'error', message: 'worktree.ps failed', showReconnect: false })
  })

  it('separates empty list copy from stale-list inline errors', () => {
    expect(
      getMobileAgentsCenterState({
        loaded: true,
        connectionState: 'connected',
        isErrorVerdict: false,
        showConnecting: false,
        visibleGroupCount: 0,
        hasActiveFilter: true,
        error: null,
        verdictLabel: 'Connected'
      })
    ).toEqual({ kind: 'empty', message: 'No agents match these filters.' })

    expect(
      getMobileAgentsCenterState({
        loaded: true,
        connectionState: 'connected',
        isErrorVerdict: false,
        showConnecting: false,
        visibleGroupCount: 1,
        hasActiveFilter: false,
        error: 'stale data shown',
        verdictLabel: 'Connected'
      })
    ).toBeNull()
  })
})

function deferredResponse(): {
  promise: Promise<RpcResponse>
  resolve: (response: RpcResponse) => void
} {
  let resolve!: (response: RpcResponse) => void
  const promise = new Promise<RpcResponse>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function psSuccess(worktrees: unknown[]): RpcResponse {
  return { id: 'req-1', ok: true, result: { worktrees }, _meta: { runtimeId: 'rt-1' } }
}

describe('createMobileAgentsFetcher', () => {
  function makeHarness(initial: MobileAgentsFetchSnapshot) {
    let snapshot = initial
    const applied: Worktree[][] = []
    const errors: string[] = []
    const fetcher = createMobileAgentsFetcher({
      readCurrent: () => snapshot,
      isLoaded: () => true,
      applyWorktrees: (worktrees) => applied.push(worktrees),
      applyRequestError: (message) => errors.push(message),
      applyTransportError: (message) => errors.push(message)
    })
    return {
      fetcher,
      applied,
      errors,
      setSnapshot: (next: MobileAgentsFetchSnapshot) => {
        snapshot = next
      }
    }
  }

  it('applies a worktree.ps result for the still-current host', async () => {
    const deferred = deferredResponse()
    const client = { sendRequest: () => deferred.promise }
    const harness = makeHarness({ client, connectionState: 'connected', hostId: 'host-a' })

    const pending = harness.fetcher()
    deferred.resolve(psSuccess([]))
    await pending

    expect(harness.applied).toEqual([[]])
    expect(harness.errors).toEqual([])
  })

  it('drops a delayed worktree.ps response from a previous host', async () => {
    const deferred = deferredResponse()
    // Why: the same client instance can serve both hosts, so the guard must
    // compare the host selection itself, not just client identity.
    const client = { sendRequest: () => deferred.promise }
    const harness = makeHarness({ client, connectionState: 'connected', hostId: 'host-a' })

    const pending = harness.fetcher()
    harness.setSnapshot({ client, connectionState: 'connected', hostId: 'host-b' })
    deferred.resolve(psSuccess([{ worktreeId: 'stale-from-host-a' }]))
    await pending

    expect(harness.applied).toEqual([])
    expect(harness.errors).toEqual([])
  })

  it('drops a delayed response after the transport client was replaced', async () => {
    const deferred = deferredResponse()
    const staleClient = { sendRequest: () => deferred.promise }
    const harness = makeHarness({
      client: staleClient,
      connectionState: 'connected',
      hostId: 'host-a'
    })

    const pending = harness.fetcher()
    harness.setSnapshot({
      client: { sendRequest: () => deferredResponse().promise },
      connectionState: 'connected',
      hostId: 'host-a'
    })
    deferred.resolve(psSuccess([{ worktreeId: 'stale-from-old-client' }]))
    await pending

    expect(harness.applied).toEqual([])
    expect(harness.errors).toEqual([])
  })

  it('keeps at most one worktree.ps request in flight', async () => {
    const deferred = deferredResponse()
    let calls = 0
    const client = {
      sendRequest: () => {
        calls += 1
        return deferred.promise
      }
    }
    const harness = makeHarness({ client, connectionState: 'connected', hostId: 'host-a' })

    const first = harness.fetcher()
    const second = harness.fetcher()
    deferred.resolve(psSuccess([]))
    await Promise.all([first, second])

    expect(calls).toBe(1)
    expect(harness.applied).toEqual([[]])
  })
})
