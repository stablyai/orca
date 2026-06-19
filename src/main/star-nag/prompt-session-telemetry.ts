import { type StarNagOutcome, type StarNagPromptMode } from '../../shared/star-nag-telemetry'
import type { EventProps } from '../../shared/telemetry-events'
import { track } from '../telemetry/client'

export type StarNagPromptContext = Omit<
  EventProps<'star_nag_outcome'>,
  'outcome' | 'next_threshold' | 'cooldown_days'
>

export type StarNagPromptSession = StarNagPromptContext & {
  openedRepoTracked?: boolean
  starAttemptPromise?: Promise<boolean>
}

type StarNagOutcomeOptions = {
  mode?: StarNagPromptMode
  nextThreshold?: number
  cooldownDays?: number
}

export function trackStarNagSessionOutcome(
  session: StarNagPromptSession,
  outcome: StarNagOutcome,
  options: StarNagOutcomeOptions = {}
): void {
  const {
    openedRepoTracked: _openedRepoTracked,
    starAttemptPromise: _starAttemptPromise,
    ...context
  } = session
  track('star_nag_outcome', {
    ...context,
    outcome,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.nextThreshold === undefined ? {} : { next_threshold: options.nextThreshold }),
    ...(options.cooldownDays === undefined ? {} : { cooldown_days: options.cooldownDays })
  })
}
