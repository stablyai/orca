import { describe, expect, it, vi } from 'vitest'
import type { HostedReviewCreationBlockedReason } from '../../../src/shared/hosted-review'
import type { MobileHostedReviewEligibilityReply } from './hosted-review-reply-schema'
import {
  buildMobileCreatePrAction,
  type MobileCreatePrEligibilityState
} from './mobile-create-pr-action'

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

function action(
  overrides: {
    branch?: string | null
    eligibility?: MobileHostedReviewEligibilityReply | null
    busyAction?: string | null
  } = {}
) {
  const onCreatePr = vi.fn()
  const descriptor = buildMobileCreatePrAction({
    branch: Object.hasOwn(overrides, 'branch') ? overrides.branch : 'feature',
    eligibilityState:
      overrides.eligibility === null
        ? { kind: 'error' }
        : { kind: 'ready', eligibility: overrides.eligibility ?? eligibility() },
    busyAction: overrides.busyAction ?? null,
    onCreatePr
  })
  return { descriptor, onCreatePr }
}

describe('buildMobileCreatePrAction', () => {
  it('enables create when eligibility can create', () => {
    const { descriptor, onCreatePr } = action()

    expect(descriptor).toMatchObject({
      visible: true,
      label: 'Create Pull Request',
      disabled: false,
      pushFirst: false
    })
    descriptor.onPress()
    expect(onCreatePr).toHaveBeenCalledWith(false)
  })

  it('uses merge-request copy for GitLab', () => {
    const { descriptor } = action({
      eligibility: eligibility({ provider: 'gitlab' })
    })

    expect(descriptor.label).toBe('Create Merge Request')
  })

  it('enables push-first creation when the branch needs push', () => {
    const { descriptor, onCreatePr } = action({
      eligibility: eligibility({
        canCreate: false,
        blockedReason: 'needs_push',
        nextAction: 'push'
      })
    })

    expect(descriptor).toMatchObject({ visible: true, disabled: false, pushFirst: true })
    descriptor.onPress()
    expect(onCreatePr).toHaveBeenCalledWith(true)
  })

  it.each<HostedReviewCreationBlockedReason>([
    'dirty',
    'no_upstream',
    'needs_sync',
    'default_branch',
    'auth_required'
  ])('shows a disabled hinted action for locally actionable %s', (blockedReason) => {
    const { descriptor } = action({
      eligibility: eligibility({ canCreate: false, blockedReason })
    })

    expect(descriptor.visible).toBe(true)
    expect(descriptor.disabled).toBe(true)
    expect(descriptor.hint).toBeTruthy()
  })

  it('falls back to a disabled hinted action for other reachable blocked reasons', () => {
    const { descriptor } = action({
      eligibility: eligibility({ canCreate: false, blockedReason: 'fork_head_unsupported' })
    })

    expect(descriptor).toMatchObject({ visible: true, disabled: true })
    expect(descriptor.hint).toContain('fork')
  })

  it.each<HostedReviewCreationBlockedReason>([
    'existing_review',
    'unsupported_provider',
    'detached_head',
    null
  ])('keeps a disabled status row for %s', (blockedReason) => {
    const { descriptor } = action({
      eligibility: eligibility({ canCreate: false, blockedReason })
    })

    expect(descriptor).toMatchObject({ visible: true, disabled: true })
    expect(descriptor.hint).toBeTruthy()
  })

  it('keeps an unavailable row after errors but hides missing branches', () => {
    expect(action({ eligibility: null }).descriptor).toMatchObject({
      visible: true,
      disabled: true,
      label: 'Review status unavailable'
    })
    expect(action({ branch: null }).descriptor.visible).toBe(false)
  })

  it('shows an in-flight spinner and disables the current action', () => {
    const { descriptor } = action({ busyAction: 'create-pr' })

    expect(descriptor).toMatchObject({ visible: true, disabled: true, loading: true })
  })

  it('disables without a spinner during unrelated git work', () => {
    const { descriptor, onCreatePr } = action({ busyAction: 'stage-all' })

    expect(descriptor).toMatchObject({ visible: true, disabled: true, loading: false })
    descriptor.onPress()
    expect(onCreatePr).not.toHaveBeenCalled()
  })

  it('keeps a disabled status row for providers without review creation', () => {
    const { descriptor } = action({
      eligibility: eligibility({ provider: 'unsupported' })
    })

    expect(descriptor).toMatchObject({
      visible: true,
      disabled: true,
      label: 'Review creation unavailable for this provider'
    })
  })

  it('keeps a creatable button visible but disabled while a newer eligibility loads', () => {
    const onCreatePr = vi.fn()
    const descriptor = buildMobileCreatePrAction({
      branch: 'feature',
      eligibilityState: { kind: 'loading', eligibility: eligibility({ canCreate: true }) },
      busyAction: null,
      onCreatePr
    })

    expect(descriptor).toMatchObject({ visible: true, disabled: true, loading: false })
  })
})

// Cold eligibility must reserve the Create PR row’s footprint so arriving data cannot shift a list being read.
describe('cold-mount layout stability (issue #8411)', () => {
  const coldMount: MobileCreatePrEligibilityState[] = [
    { kind: 'loading', eligibility: null },
    { kind: 'ready', eligibility: eligibility({ canCreate: true }) }
  ]

  it('reserves the button row while the first eligibility request is in flight', () => {
    const descriptors = coldMount.map((eligibilityState) =>
      buildMobileCreatePrAction({
        branch: 'feature',
        eligibilityState,
        busyAction: null,
        onCreatePr: vi.fn()
      })
    )

    const footprint = descriptors.map(({ visible }) => visible)

    expect(footprint).toEqual([true, true])
  })

  it.each([
    [
      'existing review',
      {
        kind: 'ready',
        eligibility: eligibility({ canCreate: false, blockedReason: 'existing_review' })
      } satisfies MobileCreatePrEligibilityState
    ],
    [
      'unsupported provider',
      {
        kind: 'ready',
        eligibility: eligibility({ provider: 'unsupported' })
      } satisfies MobileCreatePrEligibilityState
    ],
    ['eligibility error', { kind: 'error' } satisfies MobileCreatePrEligibilityState]
  ])('keeps the cold-load footprint when %s resolves', (_label, resolvedState) => {
    const footprint = [coldMount[0], resolvedState].map((eligibilityState) => {
      const descriptor = buildMobileCreatePrAction({
        branch: 'feature',
        eligibilityState,
        busyAction: null,
        onCreatePr: vi.fn()
      })
      return descriptor.visible
    })

    expect(footprint).toEqual([true, true])
  })

  it('does not offer a tappable action against unresolved eligibility', () => {
    const descriptor = buildMobileCreatePrAction({
      branch: 'feature',
      eligibilityState: { kind: 'loading', eligibility: null },
      busyAction: null,
      onCreatePr: vi.fn()
    })

    expect(descriptor.disabled).toBe(true)
  })
})
