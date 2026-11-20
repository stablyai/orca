import { generateBranchNameFromContext } from '../../text-generation/commit-message-text-generation'
import type { FirstWorkAttempt } from './first-work-rename-attempts'

/** Waits for a background generation slot; a replaced workspace or `stillWanted` false starts no CLI. */
export function generateFirstWorkName(
  attempt: FirstWorkAttempt,
  stillWanted: () => boolean,
  ...[context, params, target]: Parameters<typeof generateBranchNameFromContext>
): ReturnType<typeof generateBranchNameFromContext> {
  attempt.assertIncarnation()
  return generateBranchNameFromContext(
    context,
    params,
    target,
    attempt.generation.admitWhile(() => attempt.isIncarnationCurrent() && stillWanted())
  )
}
