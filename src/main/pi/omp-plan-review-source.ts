import {
  OMP_PLAN_REVIEW_ANSWER_PREFIX,
  OMP_PLAN_REVIEW_DISMISS
} from '../../shared/omp-plan-review-prompt'

/** OMP 18.12+ reports its plan review overlay; older builds never fire these events. */
export function getOmpPlanReviewHandlerSourceLines(): string[] {
  return [
    `  const OMP_PLAN_REVIEW_ANSWER_PREFIX = ${JSON.stringify(OMP_PLAN_REVIEW_ANSWER_PREFIX)}`,
    `  const OMP_PLAN_REVIEW_DISMISS = ${JSON.stringify(OMP_PLAN_REVIEW_DISMISS)}`,
    '  let ompPlanReview: { reviewId: string; stopInput: () => void } | null = null',
    '',
    "  onStatus('plan_review_requested', (event, ctx) => {",
    '    updateRuntimeOmpSessionMetadata(ctx)',
    '    ompPlanReview?.stopInput()',
    '    ompPlanReview = null',
    "    if (!isOmpRuntime() || typeof ctx?.resolvePlanReview !== 'function' || typeof ctx?.ui?.onTerminalInput !== 'function') return",
    '    const reviewId = event.reviewId',
    // Why: the overlay owns the keyboard; input listeners see each whole OSC before it does.
    '    const stopInput = ctx.ui.onTerminalInput((data) => {',
    "      if (typeof data !== 'string' || !data.startsWith(OMP_PLAN_REVIEW_ANSWER_PREFIX)) return undefined",
    "      const [answerId, choice] = data.slice(OMP_PLAN_REVIEW_ANSWER_PREFIX.length).replace(/\\x07$/, '').split(';')",
    // Why: a card drawn for a replaced review must not answer or dismiss this one.
    '      if (answerId !== reviewId) return { consume: true }',
    // Why: OMP has no dismiss API; the overlay closes on its own cancel key.
    "      if (choice === OMP_PLAN_REVIEW_DISMISS) return { data: '\\x1b' }",
    '      ctx.resolvePlanReview(reviewId, choice)',
    '      return { consume: true }',
    '    })',
    '    ompPlanReview = { reviewId, stopInput }',
    "    post('plan_review_requested', {",
    '      review_id: reviewId,',
    '      plan: event.planContent,',
    '      options: (event.options ?? []).filter((option) => !option.disabled).map((option) => ({ id: option.id, label: option.label })),',
    '    })',
    '  })',
    '',
    "  onStatus('plan_review_resolved', (event, ctx) => {",
    '    updateRuntimeOmpSessionMetadata(ctx)',
    // Why: a replaced review reports its close after the replacement opened.
    '    if (!ompPlanReview || ompPlanReview.reviewId !== event.reviewId) return',
    '    ompPlanReview.stopInput()',
    '    ompPlanReview = null',
    '    let isIdle = true',
    '    try {',
    "      if (typeof ctx?.isIdle === 'function') isIdle = ctx.isIdle() === true",
    '    } catch {}',
    "    post('plan_review_resolved', { is_idle: isIdle })",
    '  })',
    ''
  ]
}
