import type { PRState } from '../../../src/shared/github/pull-request-types'

export function canEditPRTitle(state: PRState | null | undefined): boolean {
  return state === 'open' || state === 'draft'
}

export function isSubmittablePRTitle(draft: string, current: string): boolean {
  const next = draft.trim()
  return next.length > 0 && next !== current.trim()
}

export type UpdatePRTitleParams = { prNumber: number; title: string }

export function buildUpdatePRTitleParams(
  prNumber: number,
  draft: string,
  current: string
): UpdatePRTitleParams | null {
  if (!isSubmittablePRTitle(draft, current)) {
    return null
  }
  return { prNumber, title: draft.trim() }
}
