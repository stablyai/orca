// A step a bot's Google setup handed to the person (publishing the app, say) that they finished
// outside its card. Once Google already works for the setup, Orca records it from what it reads, so
// the run doesn't wait on a Done the person may never see; the bot still can't claim it.
import type { GoogleStatusView } from '../../shared/google/google-connect-types'
import { GOOGLE_CHOICE_SERVICES } from '../../shared/google/google-scopes'
import {
  googleSetupAccount,
  googleSetupDoneRefusal,
  googleSetupKeyBlocker
} from '../../shared/google/google-setup-blocker'
import {
  GOOGLE_SETUP_STEPS,
  type GoogleSetupRun,
  type GoogleSetupStep
} from '../../shared/google/google-setup-run'
import { writeGoogleSetupCards } from './google-setup-chat-cards'
import { GOOGLE_SETUP_FINISHED_OUTSIDE_NOTE, googleSetupRuns } from './google-setup-runs'

type SetupGoogle = Pick<GoogleStatusView, 'client' | 'accounts' | 'clientKey'>

const BEFORE_KEY = GOOGLE_SETUP_STEPS.slice(0, GOOGLE_SETUP_STEPS.indexOf('client'))

/** Handed steps before the key that a working sign-in shows are finished: connect is done and every
 *  chosen service is ready. */
export function googleSetupStepsFinishedOutside(
  run: GoogleSetupRun,
  google: SetupGoogle
): GoogleSetupStep[] {
  if (run.state !== 'running' || run.steps.connect?.status !== 'done') {
    return []
  }
  const account = googleSetupAccount(run, google.accounts)
  const chosen = run.services ?? []
  const ready =
    account !== null &&
    chosen.length > 0 &&
    account.status === 'connected' &&
    !googleSetupKeyBlocker(run, google) &&
    chosen.every((choice) =>
      GOOGLE_CHOICE_SERVICES[choice].every((service) =>
        account.services.some((entry) => entry.service === service && entry.state === 'ready')
      )
    )
  return ready ? BEFORE_KEY.filter((step) => run.steps[step]?.status === 'needs-user') : []
}

/** Records those steps on the run as stored now (a request may have moved it since `run` was read). */
export function markGoogleSetupFinishedOutside(
  run: GoogleSetupRun,
  google: SetupGoogle
): GoogleSetupRun {
  const stored = googleSetupRuns().get(run.botId) ?? run
  const steps = googleSetupStepsFinishedOutside(stored, google)
  return steps.length > 0
    ? googleSetupRuns().apply(stored.botId, 'owner', { action: 'finished-outside', steps })
    : stored
}

/** Records those steps and, when nothing else is left, finishes a run that has any; the run as saved.
 *  Finishing reads the run, not this call's marks, so a failed save retries on the next read. */
export function reconcileGoogleSetupFinishedOutside(
  run: GoogleSetupRun | null,
  google: SetupGoogle | null,
  chatSessionId: string | undefined
): GoogleSetupRun | null {
  if (!run || !google) {
    return run
  }
  const marked = markGoogleSetupFinishedOutside(run, google)
  const outside = GOOGLE_SETUP_STEPS.some(
    (step) => marked.steps[step]?.note === GOOGLE_SETUP_FINISHED_OUTSIDE_NOTE
  )
  if (marked.state !== 'running' || !outside || googleSetupDoneRefusal(marked, google)) {
    return marked
  }
  const next = googleSetupRuns().apply(marked.botId, 'owner', { action: 'done' })
  writeGoogleSetupCards(chatSessionId, run, next)
  return next
}
