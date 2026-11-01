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

// Why: Save resolves after its reread, so only the latest edit may close the editor; a newer keystroke,
// Save or edit start supersedes an older Save's completion (and keeps a newer failure visible).
export function createPrTitleEditOwnership() {
  let seq = 0
  return {
    touch: (): void => {
      seq += 1
    },
    save: async (run: () => Promise<boolean>): Promise<boolean> => {
      seq += 1
      const mine = seq
      const ok = await run()
      return ok && mine === seq
    }
  }
}
