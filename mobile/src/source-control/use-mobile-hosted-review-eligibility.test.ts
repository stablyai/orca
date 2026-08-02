import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewCreationEligibility } from '../../../src/shared/hosted-review'
import {
  buildMobileHostedReviewEligibilityLoadKey,
  eligibilityStateAfterMobileHostedReviewError,
  renderedMobileHostedReviewEligibilityState,
  shouldFetchMobileHostedReviewEligibility,
  useMobileHostedReviewEligibility,
  type MobileHostedReviewEligibilityLoadKey,
  type MobileHostedReviewEligibilityLoadSnapshot
} from './use-mobile-hosted-review-eligibility'
import type { MobileCreatePrEligibilityState } from './mobile-create-pr-action'

function eligibility(
  overrides: Partial<HostedReviewCreationEligibility> = {}
): HostedReviewCreationEligibility {
  return {
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
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

  it('builds distinct keys for different branches', () => {
    const first = buildMobileHostedReviewEligibilityLoadKey({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      branch: 'feature-a',
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false
    })
    const second = buildMobileHostedReviewEligibilityLoadKey({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      branch: 'feature-b',
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false
    })

    expect(first.identity).not.toBe(second.identity)
    expect(first.fetch).not.toBe(second.fetch)
  })

  it('scopes load identity to the paired host', () => {
    const input = {
      worktreeId: 'repo-1::/workspace',
      branch: 'feature',
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false
    }
    const local = buildMobileHostedReviewEligibilityLoadKey({ ...input, hostId: 'local' })
    const ssh = buildMobileHostedReviewEligibilityLoadKey({ ...input, hostId: 'ssh-builder' })

    expect(local.identity).not.toBe(ssh.identity)
    expect(local.fetch).not.toBe(ssh.fetch)
  })

  it('renders a superseded same-identity snapshot as loading', () => {
    const input = {
      hostId: 'host-1',
      worktreeId: 'wt-1',
      branch: 'feature',
      hasUpstream: true,
      ahead: 0,
      behind: 0
    }
    const older = buildMobileHostedReviewEligibilityLoadKey({
      ...input,
      hasUncommittedChanges: false
    })
    const newest = buildMobileHostedReviewEligibilityLoadKey({
      ...input,
      hasUncommittedChanges: true
    })

    expect(older.identity).toBe(newest.identity)
    expect(
      renderedMobileHostedReviewEligibilityState({
        snapshot: loadSnapshot(older, { kind: 'ready', eligibility: eligibility() }),
        key: newest,
        shouldFetch: true
      })
    ).toMatchObject({ kind: 'loading', eligibility: eligibility() })
  })

  it('fails closed after errors', () => {
    expect(eligibilityStateAfterMobileHostedReviewError()).toEqual({ kind: 'error' })
  })
})

// #8411: what the hook returns is what paints. A fetch-imminent frame must not
// render as `idle` (hidden row) or the Create PR row pops in a frame later.
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

  it('passes resolved and refetch states through untouched', () => {
    const key = buildMobileHostedReviewEligibilityLoadKey({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      branch: 'feature',
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false
    })
    const ready = { kind: 'ready', eligibility: eligibility() } as const
    const refetch = { kind: 'loading', eligibility: eligibility() } as const
    const error = { kind: 'error' } as const

    for (const state of [ready, refetch, error]) {
      expect(
        renderedMobileHostedReviewEligibilityState({
          snapshot: loadSnapshot(key, state),
          key,
          shouldFetch: true
        })
      ).toBe(state)
    }
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

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not let an older response overwrite the newest state', async () => {
    type Response = { ok: true; result: HostedReviewCreationEligibility }
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
    expect(requests).toHaveLength(2)

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
    type Response = { ok: true; result: HostedReviewCreationEligibility }
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

  it('invalidates a request when its hook instance unmounts', async () => {
    type Response = { ok: true; result: HostedReviewCreationEligibility }
    const requests: ReturnType<typeof deferred<Response>>[] = []
    const client = {
      sendRequest: vi.fn(() => {
        const request = deferred<Response>()
        requests.push(request)
        return request.promise
      })
    }
    const newest = eligibility({ canCreate: false, blockedReason: 'existing_review' })

    function Harness(): null {
      renderedState = useMobileHostedReviewEligibility({
        client: client as never,
        connState: 'connected',
        hostId: 'host-1',
        worktreeId: 'wt-1',
        branch: 'feature',
        hasUpstream: true,
        ahead: 0,
        behind: 0,
        hasUncommittedChanges: false
      })
      return null
    }

    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
    act(() => renderer?.unmount())
    renderer = null
    await act(async () => {
      renderer = create(createElement(Harness))
      await Promise.resolve()
    })
    expect(requests).toHaveLength(2)

    await act(async () => {
      requests[1]!.resolve({ ok: true, result: newest })
      await Promise.resolve()
    })
    await act(async () => {
      requests[0]!.resolve({ ok: true, result: eligibility() })
      await Promise.resolve()
    })

    expect(renderedState).toMatchObject({ kind: 'ready', eligibility: newest })
  })
})
