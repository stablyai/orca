// The phone's words for the Google setup cards, in the computer's English (google-setup-card-copy,
// google-setup-blocker-copy and google-copy in the renderer).
import type { GoogleServiceChoice } from '../../../../../../src/shared/google/google-scopes'
import type {
  GoogleSetupMode,
  GoogleSetupStep
} from '../../../../../../src/shared/google/google-setup-run'
import type { Translate } from '../../../../i18n/mobile-i18n'

export function googleSetupPathTitle(t: Translate, mode: GoogleSetupMode): string {
  switch (mode) {
    case 'do-it-for-me':
      return t('chat.botCards.google.path.doIt', 'Do it for me')
    case 'guide-here':
      return t('chat.botCards.google.path.guideHere', 'Guide me here')
    case 'guide-browser':
      return t('chat.botCards.google.path.guideBrowser', 'Guide me in my browser')
  }
}

export function googleSetupPathNote(t: Translate, mode: GoogleSetupMode, bot: string): string {
  switch (mode) {
    case 'do-it-for-me':
      return t('chat.botCards.google.path.doItNote', '{{bot}} clicks through it', { bot })
    case 'guide-here':
      return t('chat.botCards.google.path.guideHereNote', 'You click, in Orca')
    case 'guide-browser':
      return t('chat.botCards.google.path.guideBrowserNote', 'You click, in your browser')
  }
}

export function googleChoiceLabel(t: Translate, choice: GoogleServiceChoice): string {
  switch (choice) {
    case 'gmail':
      return t('chat.botCards.google.choice.gmail', 'Gmail')
    case 'calendar':
      return t('chat.botCards.google.choice.calendar', 'Calendar')
    case 'files':
      return t('chat.botCards.google.choice.files', 'Drive, Docs and Sheets')
  }
}

export function googleChoiceDescription(t: Translate, choice: GoogleServiceChoice): string {
  switch (choice) {
    case 'gmail':
      return t(
        'chat.botCards.google.choice.gmailDescription',
        'Search and read mail, write drafts, send when you say so'
      )
    case 'calendar':
      return t('chat.botCards.google.choice.calendarDescription', 'See, create and move events')
    case 'files':
      return t('chat.botCards.google.choice.filesDescription', 'Find, read and edit files')
  }
}

export function googleServicesList(
  t: Translate,
  locale: string,
  choices: readonly GoogleServiceChoice[]
): string {
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(
    choices.map((choice) => googleChoiceLabel(t, choice))
  )
}

/** A step's name in the progress list. */
export function googleSetupStepTitle(
  t: Translate,
  locale: string,
  step: GoogleSetupStep,
  choices: readonly GoogleServiceChoice[]
): string {
  switch (step) {
    case 'account':
      return t('chat.botCards.google.step.account', 'Sign in to Google')
    case 'project':
      return t('chat.botCards.google.step.project', 'Create a project')
    case 'apis':
      return t('chat.botCards.google.step.apis', 'Turn on {{services}}', {
        services: googleServicesList(t, locale, choices)
      })
    case 'branding':
      return t('chat.botCards.google.step.branding', 'Set up Google’s sign-in screen')
    case 'links':
      return t('chat.botCards.google.step.links', 'Add your app’s links')
    case 'publish':
      return t('chat.botCards.google.step.publish', 'Publish the app')
    case 'client':
      return t('chat.botCards.google.step.client', 'Create the app’s key')
    case 'connect':
      return t('chat.botCards.google.step.connect', 'Connect and check')
  }
}

/** What to do on a step, one line each, with its key words in <b>. */
export function googleSetupStepNotes(
  t: Translate,
  step: GoogleSetupStep,
  kind: 'work' | 'personal' | undefined
): string[] {
  switch (step) {
    case 'account':
    case 'connect':
      return []
    case 'project':
      return [
        t(
          'chat.botCards.google.notes.project.account',
          'Check the account at the top right is the one you want.'
        ),
        t(
          'chat.botCards.google.notes.project.create',
          'Click <b>Create</b>. The name doesn’t matter.'
        )
      ]
    case 'apis':
      return [
        t(
          'chat.botCards.google.notes.apis.project',
          'Check the project at the top is the one you just made.'
        ),
        t('chat.botCards.google.notes.apis.enable', 'Click <b>Next</b>, then <b>Enable</b>.')
      ]
    case 'branding':
      return [
        t('chat.botCards.google.notes.branding.start', 'Click <b>Get started</b>.'),
        t(
          'chat.botCards.google.notes.branding.name',
          'App name <b>Orca</b>, and your email as the support email.'
        ),
        kind === 'personal'
          ? t('chat.botCards.google.notes.branding.external', 'Audience: <b>External</b>.')
          : kind === 'work'
            ? t('chat.botCards.google.notes.branding.internal', 'Audience: <b>Internal</b>.')
            : t(
                'chat.botCards.google.notes.branding.either',
                'Audience: <b>External</b> for a Gmail account, <b>Internal</b> for a work account.'
              ),
        t('chat.botCards.google.notes.branding.contact', 'Your email as the contact email.'),
        t(
          'chat.botCards.google.notes.branding.agree',
          'Tick <b>I agree to the Google API Services: User Data Policy</b>, then <b>Create</b>.'
        )
      ]
    case 'links':
      return [
        t(
          'chat.botCards.google.notes.links.domain',
          'Under <b>App domain</b>, paste the home page and privacy policy links.'
        ),
        t(
          'chat.botCards.google.notes.links.authorized',
          'Under <b>Authorized domains</b>, add the domain.'
        ),
        t('chat.botCards.google.notes.links.save', 'Click <b>Save</b>.')
      ]
    case 'publish':
      return [
        t(
          'chat.botCards.google.notes.publish.publish',
          'Click <b>Publish app</b>, then <b>Confirm</b>.'
        ),
        t(
          'chat.botCards.google.notes.publish.why',
          'A published app keeps you signed in past 7 days.'
        )
      ]
    case 'client':
      return [
        t(
          'chat.botCards.google.notes.client.type',
          'Application type: <b>Desktop app</b>, then <b>Create</b>.'
        ),
        t(
          'chat.botCards.google.notes.client.agent',
          'If you see <b>Use this client for an AI-powered agent</b>, tick it.'
        ),
        t(
          'chat.botCards.google.notes.client.download',
          'Click <b>Download JSON</b>. Orca saves the key.'
        )
      ]
  }
}

/** The owner's three cards: how, which services, then their sign-in. */
export function googleSetupOwnerStep(t: Translate, step: 1 | 2 | 3): string {
  return t('chat.botCards.google.ownerStep', 'Step {{step}} of 3', { step })
}
