import { generateBranchNameFromContext } from '../../text-generation/commit-message-text-generation'
import { runInBackgroundGenerationSlot } from '../../text-generation/execution/background-generation-slots'
import type { FirstWorkAttempt } from './first-work-rename-attempts'

/** Waits for a background generation slot; a replaced workspace or `stillWanted` false starts no CLI. */
export function generateFirstWorkName(
  attempt: FirstWorkAttempt,
  stillWanted: () => boolean,
  ...[context, params, target]: Parameters<typeof generateBranchNameFromContext>
): ReturnType<typeof generateBranchNameFromContext> {
  return runInBackgroundGenerationSlot(attempt.generationPriority, (slotHeld) => {
    attempt.assertIncarnation()
    return generateBranchNameFromContext(
      context,
      params,
      target,
      () => slotHeld() && attempt.isIncarnationCurrent() && stillWanted()
    )
  })
}
