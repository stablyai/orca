import { describe, expect, it, vi } from 'vitest'

import { buildOmpPlanReviewAnswer } from '../../shared/omp-plan-review-prompt'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

// Shape captured from omp 18.12.2's plan_review_requested.
const REVIEW_ID = '86949d10-20aa-46d4-9359-4e1e71467d8f'
const PLAN_REVIEW_REQUEST = {
  type: 'plan_review_requested',
  reviewId: REVIEW_ID,
  sessionId: 'session-1',
  title: 'Add-a-greeting',
  planFilePath: 'local://demo-plan.md',
  planContent: '# Add a greeting\n\n1. Create hello.txt\n',
  options: [
    { id: 'execute', label: 'Approve and execute', disabled: false },
    { id: 'keep', label: 'Approve and keep context (~7.1k / 8.2k)', disabled: true },
    { id: 'refine', label: 'Refine plan', disabled: false }
  ]
}

function createPlanReviewContext(): {
  ctx: HookContext
  resolvePlanReview: ReturnType<typeof vi.fn>
  readInput: (data: string) => { consume?: boolean; data?: string } | undefined
} {
  let listener: ((data: string) => { consume?: boolean; data?: string } | undefined) | null = null
  const resolvePlanReview = vi.fn(() => true)
  return {
    ctx: {
      isIdle: () => true,
      resolvePlanReview,
      ui: {
        onTerminalInput: (handler) => {
          listener = handler
          return () => {
            listener = null
          }
        }
      }
    },
    resolvePlanReview,
    readInput: (data) => listener?.(data)
  }
}

describe('OMP plan review forwarding', () => {
  it('posts the open review and answers it from the terminal input Orca writes', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { ctx, resolvePlanReview, readInput } = createPlanReviewContext()

    await harness.callHook('plan_review_requested', PLAN_REVIEW_REQUEST, ctx)
    expect(readInput('x')).toBeUndefined()
    expect(readInput(buildOmpPlanReviewAnswer('stale-review', 'execute'))).toEqual({
      consume: true
    })
    expect(resolvePlanReview).not.toHaveBeenCalled()
    expect(readInput(buildOmpPlanReviewAnswer(REVIEW_ID, 'execute'))).toEqual({ consume: true })
    expect(resolvePlanReview).toHaveBeenCalledWith(REVIEW_ID, 'execute')

    await harness.callHook(
      'plan_review_resolved',
      { reviewId: REVIEW_ID, choice: 'execute', by: 'extension' },
      ctx
    )
    expect(readInput(buildOmpPlanReviewAnswer(REVIEW_ID, 'execute'))).toBeUndefined()

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(
      harness.fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).payload)
    ).toEqual([
      expect.objectContaining({
        hook_event_name: 'plan_review_requested',
        review_id: REVIEW_ID,
        plan: PLAN_REVIEW_REQUEST.planContent,
        options: [
          { id: 'execute', label: 'Approve and execute' },
          { id: 'refine', label: 'Refine plan' }
        ]
      }),
      expect.objectContaining({ hook_event_name: 'plan_review_resolved', is_idle: true })
    ])
  })

  it('keeps the replacement review answerable when the replaced one reports its close', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { ctx, resolvePlanReview, readInput } = createPlanReviewContext()

    await harness.callHook(
      'plan_review_requested',
      { ...PLAN_REVIEW_REQUEST, reviewId: 'old' },
      ctx
    )
    await harness.callHook('plan_review_requested', PLAN_REVIEW_REQUEST, ctx)
    await harness.callHook('plan_review_resolved', { reviewId: 'old', choice: undefined }, ctx)

    readInput(buildOmpPlanReviewAnswer(REVIEW_ID, 'save'))
    expect(resolvePlanReview).toHaveBeenCalledWith(REVIEW_ID, 'save')
  })

  it('closes only the open review when its card asks to refine', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { ctx, resolvePlanReview, readInput } = createPlanReviewContext()

    await harness.callHook('plan_review_requested', PLAN_REVIEW_REQUEST, ctx)

    expect(readInput(buildOmpPlanReviewAnswer('replaced-review', 'dismiss'))).toEqual({
      consume: true
    })
    expect(readInput(buildOmpPlanReviewAnswer(REVIEW_ID, 'dismiss'))).toEqual({ data: '\x1b' })
    expect(resolvePlanReview).not.toHaveBeenCalled()
  })
})
