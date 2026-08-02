import type { PRState } from '../../../src/shared/types'

// Pure helpers for the inline PR-title edit affordance. Kept free of React/native
// imports so they unit-test under the node Vitest config, mirroring the other
// mobile PR sidebar state modules.

// The title is editable only on an active hosted review (open/draft). A
// closed/merged review is no longer an editable surface (desktop parity). Kept
// provider-agnostic — the gate is the generic review state, not a GitHub field.
export function canEditPRTitle(state: PRState | null | undefined): boolean {
  return state === 'open' || state === 'draft'
}

// A title is submittable only when it is non-empty after trimming AND differs from
// the current title (the host rejects empty titles; an unchanged title is a no-op).
export function isSubmittablePRTitle(draft: string, current: string): boolean {
  const next = draft.trim()
  return next.length > 0 && next !== current.trim()
}

export type UpdatePRTitleParams = { prNumber: number; title: string }

// Build the github.updatePRTitle payload. Trims the draft so trailing whitespace
// never reaches the host. Returns null when the draft is not submittable so the
// caller skips a no-op request (empty/unchanged).
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
