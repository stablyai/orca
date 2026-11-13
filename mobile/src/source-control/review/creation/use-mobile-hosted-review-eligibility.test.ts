import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileHostedReviewEligibilityReply } from './hosted-review-reply-schema'
import {
  buildMobileHostedReviewEligibilityLoadKey,
  renderedMobileHostedReviewEligibilityState,
  shouldFetchMobileHostedReviewEligibility,
  useMobileHostedReviewEligibility,
  type MobileHostedReviewEligibilityLoadKey,
  type MobileHostedReviewEligibilityLoadSnapshot
} from './use-mobile-hosted-review-eligibility'
import type { MobileCreatePrEligibilityState } from './mobile-create-pr-action'

function eligibility(
  overrides: Partial<MobileHostedReviewEligibilityReply> = {}
): MobileHostedReviewEligibilityReply {
  return {
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    reviewLookupOutcome: 'not_found',
    defaultBaseRef: 'main',
    title: 'feature',
    body: '',
    ...overrides
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function loadSnapshot(
  key: MobileHostedReviewEligibilityLoadKey,
  state: MobileCreatePrEligibilityState
): MobileHostedReviewEligibilityLoadSnapshot {
  return { key, state }
}

describe('mobile hosted review eligibility loader core', () => {
  it('does not fetch while disconnected or detached', () => {
    expect(
      shouldFetchMobileHostedReviewEligibility({
        client: { sendRequest: async () => ({ ok: true }) } as never,
        connState: 'disconnected',
        branch: 'feature'
      })
    ).toBe(false)
    expect(
      shouldFetchMobileHostedReviewEligibility({
        client: { sendRequest: async () => ({ ok: true }) } as never,
        connState: 'connected',
        branch: null
      })
    ).toBe(false)
  })
})

// Fetch-imminent must render loading immediately; an idle frame would shift the list when Create PR appears.
describe('rendered eligibility state', () => {
  it('renders fetch-imminent idle as an in-flight load', () => {
    const key = buildMobileHostedReviewEligibilityLoadKey({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      branch: 'feature',
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false
    })
    expect(
      renderedMobileHostedReviewEligibilityState({
        snapshot: loadSnapshot(key, { kind: 'idle' }),
        key,
        shouldFetch: true
      })
    ).toEqual({ kind: 'loading', eligibility: null })
  })

  it('renders idle when a fetch is not possible, hiding stale snapshots in the same render', () => {
    const key = buildMobileHostedReviewEligibilityLoadKey({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      branch: 'feature',
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false
    })
    expect(
      renderedMobileHostedReviewEligibilityState({
        snapshot: loadSnapshot(key, { kind: 'ready', eligibility: eligibility() }),
        key,
        shouldFetch: false
      })
    ).toEqual({ kind: 'idle' })
  })
})

describe('eligibility request ordering', () => {
  let renderer: ReactTestRenderer | null = null
  let renderedState: MobileCreatePrEligibilityState = { kind: 'idle' }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not let an older response overwrite the newest state', async () => {
    type Response = { ok: true; result: MobileHostedReviewEligibilityReply }
    const requests: ReturnType<typeof deferred<Response>>[] = []
    const client = {
      sendRequest: vi.fn(() => {
        const request = deferred<Response>()
        requests.push(request)
        return request.promise
      })
    }
    const newest = eligibility({ canCreate: false, blockedReason: 'existing_review' })
    const older = eligibility()

    function Harness({ dirty }: { dirty: boolean }): null {
      renderedState = useMobileHostedReviewEligibility({
        client: client as never,
        connState: 'connected',
        hostId: 'host-1',
        worktreeId: 'wt-1',
        branch: 'feature',
        hasUpstream: true,
        ahead: 0,
        behind: 0,
        hasUncommittedChanges: dirty
      })
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness, { dirty: false }))
      await Promise.resolve()
    })
    await act(async () => {
      renderer?.update(createElement(Harness, { dirty: true }))
      await Promise.resolve()
    })

    await act(async () => {
      requests[1]!.resolve({ ok: true, result: newest })
      await Promise.resolve()
    })
    await act(async () => {
      requests[0]!.resolve({ ok: true, result: older })
      await Promise.resolve()
    })

    expect(renderedState).toMatchObject({ kind: 'ready', eligibility: newest })
  })

  it('disables a ready snapshot in the render that changes its fetch key', async () => {
    type Response = { ok: true; result: MobileHostedReviewEligibilityReply }
    const requests: ReturnType<typeof deferred<Response>>[] = []
    const client = {
      sendRequest: vi.fn(() => {
        const request = deferred<Response>()
        requests.push(request)
        return request.promise
      })
    }
    const ready = eligibility()

    function Harness({ dirty }: { dirty: boolean }): null {
      renderedState = useMobileHostedReviewEligibility({
        client: client as never,
        connState: 'connected',
        hostId: 'host-1',
        worktreeId: 'wt-1',
        branch: 'feature',
        hasUpstream: true,
        ahead: 0,
        behind: 0,
        hasUncommittedChanges: dirty
      })
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness, { dirty: false }))
      await Promise.resolve()
    })
    await act(async () => {
      requests[0]!.resolve({ ok: true, result: ready })
      await Promise.resolve()
    })
    expect(renderedState).toMatchObject({ kind: 'ready', eligibility: ready })

    await act(async () => {
      renderer?.update(createElement(Harness, { dirty: true }))
      await Promise.resolve()
    })
    expect(renderedState).toMatchObject({ kind: 'loading', eligibility: ready })
  })
})
