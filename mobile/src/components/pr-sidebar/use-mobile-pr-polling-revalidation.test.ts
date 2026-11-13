import { createElement } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../src/shared/github/pull-requests/pull-request-types'
import type { PRAutoRefreshCadence } from '../../../../src/shared/review-refresh-policy'
import { createOrcaQueryClient } from '../../query/orca-query-client'
import { hostQueryKey } from '../../query/host-query-key'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { stubRpcClient } from '../../transport/rpc/rpc-client-test-stub'
import {
  DESKTOP_SOURCE_CONTROL_DEFAULTS,
  NO_SOURCE_CONTROL_SETTINGS_INPUT,
  sourceControlSettingsQuery
} from '../../source-control/mobile-source-control-settings'
import {
  prBranchReviewQuery,
  type PrQueryScope
} from '../../source-control/review/mobile-pr-queries'
import type { PrBranchReview } from '../../source-control/review/mobile-pr-sidebar-state'
import { useMobilePrPolling } from './use-mobile-pr-polling'

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (effect: () => (() => void) | void) => React.useEffect(effect, [effect])
  }
})

const WORKTREE = 'repo42::/p'
const TARGET = { exec: 'local' as const, worktree: WORKTREE }
const BRANCH = { branch: 'feature', head: 'head-a' }
const pr = {
  number: 7,
  title: 'Shown',
  state: 'open',
  url: 'https://github.com/acme/repo/pull/7',
  checksStatus: 'pending',
  updatedAt: '2026-11-01T00:00:00Z',
  mergeable: 'MERGEABLE',
  headSha: 'head-a'
} satisfies PRInfo

type PendingCall = { method: string; params: unknown; settle: (reply: RpcResponse) => void }

describe('the phone PR screen’s timer with host revalidation receipts', () => {
  let renderer: { unmount: () => void } | null = null
  let queryClient: QueryClient
  let calls: PendingCall[]

  beforeEach(() => {
    vi.useFakeTimers()
    calls = []
    queryClient = createOrcaQueryClient()
  })
  afterEach(async () => {
    act(() => renderer?.unmount())
    renderer = null
    await queryClient.cancelQueries()
    queryClient.clear()
    vi.useRealTimers()
  })

  // Only the PR read is answered by the test; every other host read fails, as an unreachable one would.
  const client = stubRpcClient({
    sendRequest: (method, params) =>
      method === 'github.prForBranch'
        ? new Promise<RpcResponse>((settle) => calls.push({ method, params, settle }))
        : Promise.reject(new Error(`not answered: ${method}`))
  })
  const scope: PrQueryScope = {
    host: { hostId: 'host-1', client },
    target: TARGET,
    branchInput: BRANCH,
    checksInput: null,
    detailsInput: null
  }
  const branchKey = hostQueryKey('host-1', prBranchReviewQuery.family, TARGET, BRANCH)
  const settingsKey = hostQueryKey(
    'host-1',
    sourceControlSettingsQuery.family,
    { exec: 'local' },
    NO_SOURCE_CONTROL_SETTINGS_INPUT
  )

  function setHostCadence(prAutoRefresh: PRAutoRefreshCadence): void {
    act(() => {
      queryClient.setQueryData(settingsKey, { ...DESKTOP_SOURCE_CONTROL_DEFAULTS, prAutoRefresh })
    })
  }

  async function mount(): Promise<void> {
    setHostCadence('default')
    const shown: PrBranchReview = { kind: 'found', pr, pushTarget: null, linkedPRNumber: null }
    queryClient.setQueryData(branchKey, shown)
    function Harness(): null {
      useMobilePrPolling({
        queries: scope,
        state: {
          kind: 'ready',
          data: { pr, details: null, checks: [], checksError: null, pushTarget: null }
        },
        live: 'checks',
        connected: true
      })
      return null
    }
    await act(async () => {
      renderer = create(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Harness))
      )
    })
  }

  async function nextPRRead(): Promise<PendingCall> {
    await vi.waitFor(() => expect(calls).toHaveLength(1), { interval: 10 })
    return calls.shift()!
  }

  async function answer(call: PendingCall, result: unknown): Promise<void> {
    await act(async () => call.settle({ id: 'call', ok: true, result, _meta: { runtimeId: 'r' } }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  const shownTitle = () => {
    const review = queryClient.getQueryData<PrBranchReview>(branchKey)
    return review?.kind === 'found' ? review.pr.title : undefined
  }

  it('keeps the shown PR on a receipt, reads again at the receipt’s delay, and stops once the host is Off', async () => {
    await mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    const timer = await nextPRRead()
    expect(timer.params).toMatchObject({ reason: 'swr', acceptRevalidationOnly: true })
    await answer(timer, { revalidation: { invalidated: true, retryAfterMs: 15_000 } })
    expect(shownTitle()).toBe('Shown')

    // The receipt's short retry, not the screen's minute.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    const retry = await nextPRRead()
    await answer(retry, {
      kind: 'found',
      fetchedAt: 1,
      pr: { ...pr, title: 'Cached' },
      revalidation: { retryAfterMs: 40_000 }
    })
    expect(shownTitle()).toBe('Cached')

    // A longer known gate waits longer; the host turns Off before the reply lands.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(39_000)
    })
    expect(calls).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    const gated = await nextPRRead()
    setHostCadence('off')
    await answer(gated, { revalidation: { invalidated: true, retryAfterMs: 10_000 } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(calls).toHaveLength(0)
    expect(shownTitle()).toBe('Cached')
  })
})
