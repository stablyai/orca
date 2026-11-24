// A step of a bot's Google setup that the person finished outside its card: one handed to them
// (publishing the app, say), or signing in from Settings rather than the Connect card. Once Google
// already works for the setup, Orca records it from what it reads, so the run doesn't wait on a Done
// the person may never see; the bot still can't claim it.
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
import { GOOGLE_SETUP_FINISHED_OUTSIDE_NOTE } from './google-setup-rules'
import { googleSetupRuns } from './google-setup-runs'

type SetupGoogle = Pick<GoogleStatusView, 'client' | 'accounts' | 'clientKey'>

const BEFORE_KEY = GOOGLE_SETUP_STEPS.slice(0, GOOGLE_SETUP_STEPS.indexOf('client'))

const finished = (run: GoogleSetupRun, step: GoogleSetupStep): boolean => {
  const status = run.steps[step]?.status
  return status === 'done' || status === 'skipped'
}

/**
 * Steps a working sign-in shows are finished, once every chosen service is ready: handed steps before
 * the key, and connect when the account signed in through this setup's key somewhere else (Settings,
 * the CLI, an offer card).
 */
export function googleSetupStepsFinishedOutside(
  run: GoogleSetupRun,
  google: SetupGoogle
): GoogleSetupStep[] {
  const { client } = google
  if (run.state !== 'running' || !client || !finished(run, 'client')) {
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
  // An older host names no app: a sign-in since the key was saved went through it.
  const throughKey =
    account !== null &&
    (account.app ? account.app.clientId === client.clientId : account.connectedAt >= client.savedAt)
  const connect = finished(run, 'connect') || throughKey
  if (!ready || !connect) {
    return []
  }
  const handed = BEFORE_KEY.filter((step) => run.steps[step]?.status === 'needs-user')
  return finished(run, 'connect') ? handed : [...handed, 'connect']
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
  writeGoogleSetupCards(chatSessionId, marked, next)
  // Writing the cards stamps them, a change of its own.
  return googleSetupRuns().get(marked.botId) ?? next
}
