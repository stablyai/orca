import { useCallback } from 'react'
import type { GenerationHold } from '../generations/generation-deferred-commits'
import { useAppLeavesForeground } from './use-app-leaves-foreground'
import { useAppResumeRounds } from './app-resume-rounds'

// Leaving makes every answer stale, as the user may since have started typing; a return also asks the host for a newer build.
export function useResumeSwapConsent(
  hold: { readonly current: GenerationHold | null },
  hostId: string,
  onReturn: () => void
): (safe: boolean, round: number) => void {
  useAppLeavesForeground(() => hold.current?.withdraw())
  useAppResumeRounds(hostId, (_round, confirming) => {
    if (!confirming) {
      onReturn()
    }
  })
  return useCallback((safe, round) => hold.current?.answer(round, safe), [hold])
}
