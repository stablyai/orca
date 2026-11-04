import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PrSidebarState } from '../../session/mobile-pr-sidebar-state'
import type { PrSidebarLoadResult } from '../../session/pr-sidebar-load-result'
import type { PrTabScope } from './pr-tab-requests'
import { useMobilePrPolling } from './use-mobile-pr-polling'

vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
vi.mock('../../hooks/use-now', () => ({ useAppActive: () => true }))

let renderer: ReactTestRenderer | undefined
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})

const repo = (owner: string) => ({ owner, repo: 'widgets', host: 'github.corp' })
// One accepted state per PR, so a re-render with the same PR does not look like new checks.
const ready = (owner: string): PrSidebarState => ({
  kind: 'ready',
  data: {
    pr: {
      number: 93,
      state: 'open',
      title: owner,
      url: `https://github.corp/${owner}/widgets/pull/93`,
      prRepo: repo(owner),
      checksStatus: 'pending',
      updatedAt: '',
      mergeable: 'MERGEABLE'
    },
    details: null,
    checks: [{ name: 'ci', status: 'in_progress', conclusion: null, url: null }],
    checksError: null,
    pushTarget: null
  }
})
// The tab selects a fresh scope object for every PR incarnation, so fork -> upstream -> fork is a third owner.
const scope = (owner: string): PrTabScope => ({
  client: null,
  worktreeId: 'clone::/wt',
  branch: 'feat',
  resource: `github.corp/${owner}/widgets#pr:93`
})

it("keeps each PR incarnation's poll, backoff and cadence its own across fork -> upstream -> fork", async () => {
  const polls: ((result: PrSidebarLoadResult) => void)[] = []
  const refetch = vi.fn(
    (_options?: unknown) => new Promise<PrSidebarLoadResult>((resolve) => polls.push(resolve))
  )
  function Probe({ state, owner }: { state: PrSidebarState; owner: PrTabScope }) {
    useMobilePrPolling({ state, refetch, live: 'checks', connected: true, owner })
    return null
  }
  const show = (state: PrSidebarState, owner: PrTabScope) =>
    act(() => {
      const element = createElement(Probe, { state, owner })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
  const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms))
  const settle = (index: number, result: PrSidebarLoadResult) =>
    act(async () => polls[index](result))

  const fork = ready('fork')
  const upstream = ready('upstream')
  show(fork, scope('fork'))
  await advance(59_999)
  expect(refetch).not.toHaveBeenCalled()
  await advance(1)
  expect(refetch).toHaveBeenCalledTimes(1)
  expect(refetch).toHaveBeenLastCalledWith({ includeDetails: false, background: true })

  // Upstream #93 starts its own cadence a full interval after it arrives; the fork's held poll does not block it.
  show(upstream, scope('upstream'))
  await advance(59_999)
  expect(refetch).toHaveBeenCalledTimes(1)
  await advance(1)
  expect(refetch).toHaveBeenCalledTimes(2)

  // The fork's poll failing late neither backs upstream off nor releases upstream's own poll in flight.
  await settle(0, 'failed')
  await advance(60_000)
  expect(refetch).toHaveBeenCalledTimes(2)
  // Upstream's poll landing re-arms at its own unchanged one-minute cadence, already due.
  await settle(1, 'applied')
  await advance(0)
  expect(refetch).toHaveBeenCalledTimes(3)

  // Back to the fork is a new incarnation: a fresh full interval, not blocked by upstream's poll in flight.
  show(fork, scope('fork'))
  await advance(59_999)
  expect(refetch).toHaveBeenCalledTimes(3)
  await advance(1)
  expect(refetch).toHaveBeenCalledTimes(4)
  // Upstream's late failure leaves the fork's cadence alone: its next poll is one interval on, not a backed-off two.
  await settle(2, 'failed')
  await settle(3, 'applied')
  await advance(59_999)
  expect(refetch).toHaveBeenCalledTimes(4)
  await advance(1)
  expect(refetch).toHaveBeenCalledTimes(5)
})
