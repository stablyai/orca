// Who may move which part of a bot's Google setup run: the person's own steps (the policy box,
// sign-in, a step handed to them), and what each setup-card answer changes. Nothing a bot sends can
// hand itself the clicks back.
import {
  GOOGLE_SETUP_STEPS,
  personDoesGoogleSetupStep,
  type GoogleSetupCard,
  type GoogleSetupMode,
  type GoogleSetupRunMode,
  type GoogleSetupRun,
  type GoogleSetupStep
} from '../../shared/google/google-setup-run'
import { GOOGLE_SERVICE_CHOICES, type GoogleServiceChoice } from '../../shared/google/google-scopes'

const GOOGLE_SETUP_STEPS_SET: ReadonlySet<string> = new Set(GOOGLE_SETUP_STEPS)
const GOOGLE_SERVICE_SET: ReadonlySet<string> = new Set(GOOGLE_SERVICE_CHOICES)

export class GoogleSetupError extends Error {}

/** Who asks for a change: the bot through its CLI, or its owner through a card. */
export type GoogleSetupActor = 'bot' | 'owner'

export const PERSON_FINISHES =
  'Only the person can finish this step (signing in, or a step they took): it finishes when they press Done on its card. Tell them what is left, if anything.'

/** A run the bot starts keeps the person clicking until the owner picks a path on the card; the
 *  owner's Set up Google passes `unchosen` for the same. */
export function startMode(
  actor: GoogleSetupActor,
  asked: GoogleSetupRunMode | undefined
): GoogleSetupRunMode {
  if (actor === 'owner') {
    return asked ?? 'do-it-for-me'
  }
  if (asked === 'do-it-for-me') {
    throw new GoogleSetupError(
      'Your owner picks Do it for me on the setup card; start without --mode and ask them.'
    )
  }
  return asked ?? 'guide-here'
}

export const BOT_CANNOT_TAKE_CLICKS =
  'Only your owner can hand the clicking back to you. Ask them to press Take over from here on the card.'

/** Steps only the person can finish: signing in with the new app. */
const PERSON_STEPS: ReadonlySet<GoogleSetupStep> = new Set(['connect'])

/** Finished only by the owner's Done: sign-in, a step handed to the person, and "Let me do this one". */
export function isPersonOwnedStep(
  run: Pick<GoogleSetupRun, 'personStep' | 'steps'>,
  step: GoogleSetupStep
): boolean {
  return (
    PERSON_STEPS.has(step) || run.personStep === step || run.steps[step]?.status === 'needs-user'
  )
}

/** Whether the bot may click on the step: false while the person does the clicking. */
export const botClicks = (
  run: Pick<GoogleSetupRun, 'mode' | 'personStep'>,
  step: GoogleSetupStep
) => !personDoesGoogleSetupStep(run, step)

/**
 * A card's answer, and what it changes: the path, "Take over from here" (the bot clicks from now
 * on), "Let me do this one" (the person does one step). The bot records typed answers too, but none
 * that would give it clicks the person kept.
 */
export function recordAnswer(
  run: GoogleSetupRun,
  actor: GoogleSetupActor,
  card: GoogleSetupCard,
  values: string[],
  now: number
): void {
  const [first, second] = values
  switch (card) {
    case 'path': {
      if (first === 'import' || first === 'not-now') {
        if (actor === 'bot') {
          throw new GoogleSetupError('Only your owner imports a setup file or stops the setup.')
        }
        if (first === 'not-now') {
          run.state = 'cancelled'
        } else {
          // The team's app is in: only the owner's sign-in is left.
          for (const step of IMPORTED_STEPS) {
            run.steps[step] = { status: 'skipped', at: now }
          }
        }
        break
      }
      const mode = GOOGLE_SETUP_MODE_OF[first ?? '']
      if (!mode) {
        throw new GoogleSetupError('Choose do-it-for-me, guide-here or guide-browser.')
      }
      if (actor === 'bot' && mode === 'do-it-for-me' && run.mode !== 'do-it-for-me') {
        throw new GoogleSetupError(BOT_CANNOT_TAKE_CLICKS)
      }
      run.mode = mode
      delete run.personStep
      break
    }
    case 'step': {
      if (OWNER_ONLY_STEP_ANSWERS.has(first ?? '') && actor === 'bot') {
        throw new GoogleSetupError(OWNER_RECOVERS)
      }
      if (first === 'resume' || first === 'start-over') {
        // Continue only wakes the bot here; a stopped run and Start over are the store's.
      } else if (first === 'redo' && isStep(second)) {
        // "Make a new key": the step runs again, and the sign-in after a key waits for the new one.
        run.steps[second] = { status: 'active', at: now }
        if (second === 'client') {
          delete run.steps.connect
          delete run.keyMissed
        }
      } else if (first === 'take-over') {
        if (actor === 'bot') {
          throw new GoogleSetupError(BOT_CANNOT_TAKE_CLICKS)
        }
        run.mode = 'do-it-for-me'
        delete run.personStep
        // Steps handed to the person go back to the bot; the policy box and sign-in stay theirs.
        for (const [step, state] of Object.entries(run.steps)) {
          if (state?.status === 'needs-user' && isStep(step)) {
            run.steps[step] = { status: 'active', at: now }
          }
        }
      } else if (first === 'let-me' && isStep(second)) {
        run.personStep = second
      } else if (first === 'done' && isStep(second)) {
        // The person's own Done on a step card, their sign-in, or the app key Orca saved for them:
        // the only way a person-owned step finishes.
        if (actor === 'bot') {
          throw new GoogleSetupError(PERSON_FINISHES)
        }
        const theirs = isPersonOwnedStep(run, second) || !botClicks(run, second)
        run.steps[second] = { status: 'done', by: theirs ? 'user' : 'bot', at: now }
        if (second === 'client') {
          delete run.keyMissed
        }
        if (run.personStep === second) {
          delete run.personStep
        }
      } else {
        throw new GoogleSetupError(
          'A step answer is take-over, let-me <step>, done <step>, redo <step>, resume or start-over.'
        )
      }
      break
    }
    case 'account':
      if (first === 'other') {
        // "Use a different account": the bot has the person sign in to another one, then records it.
        delete run.account
        run.steps.account = { status: 'active', at: now }
      } else {
        run.account = first
      }
      break
    case 'kind':
      if (first !== 'work' && first !== 'personal') {
        throw new GoogleSetupError('Choose work or personal.')
      }
      run.kind = first
      break
    case 'services':
      run.services = values.filter(isService)
      break
  }
  run.answers[card] = { values, at: now, ...(actor === 'bot' ? { typed: true as const } : {}) }
}

/** Recovery buttons on the owner's cards: Make a new key, Continue, Start over. */
const OWNER_ONLY_STEP_ANSWERS: ReadonlySet<string> = new Set(['redo', 'resume', 'start-over'])

export const OWNER_RECOVERS =
  'Only your owner presses Make a new key, Continue or Start over, on the setup card. Tell them which one, in those words.'

const GOOGLE_SETUP_MODE_OF: Record<string, GoogleSetupMode | undefined> = {
  'do-it-for-me': 'do-it-for-me',
  'guide-here': 'guide-here',
  'guide-browser': 'guide-browser'
}

const IMPORTED_STEPS: readonly GoogleSetupStep[] = [
  'account',
  'project',
  'apis',
  'branding',
  'links',
  'publish',
  'client'
]

function isStep(value: string | undefined): value is GoogleSetupStep {
  return GOOGLE_SETUP_STEPS_SET.has(value ?? '')
}

function isService(value: string): value is GoogleServiceChoice {
  return GOOGLE_SERVICE_SET.has(value)
}
