// The phone's words for the Google setup cards, in the computer's English (google-setup-card-copy,
// google-setup-blocker-copy and google-copy in the renderer).
import type { GoogleServiceChoice } from '../../../../../../src/shared/google/google-scopes'
import {
  GOOGLE_SETUP_ALLOW_NAMES_UP_TO,
  type GoogleSetupAction,
  type GoogleSetupBlocker
} from '../../../../../../src/shared/google/google-setup-blocker'
import type {
  GoogleSetupMode,
  GoogleSetupStep
} from '../../../../../../src/shared/google/google-setup-run'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { getUiIntlLocale } from '../../../../i18n/ui-intl-locale'

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

export function googleServicesList(t: Translate, choices: readonly GoogleServiceChoice[]): string {
  return new Intl.ListFormat(getUiIntlLocale(), { type: 'conjunction' }).format(
    choices.map((choice) => googleChoiceLabel(t, choice))
  )
}

/** A step's name in the progress list. */
export function googleSetupStepTitle(
  t: Translate,
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
        services: googleServicesList(t, choices)
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

export function googleSetupActionText(t: Translate, action: GoogleSetupAction): string {
  switch (action.id) {
    case 'make-new-key':
      return t('chat.botCards.google.action.makeNewKey', 'Make a new key')
    case 'import-key':
      return t('chat.botCards.google.action.importKey', 'Import a key file')
    case 'allow':
      return action.services.length <= GOOGLE_SETUP_ALLOW_NAMES_UP_TO
        ? t('chat.botCards.google.action.allow', 'Allow {{services}}', {
            services: googleServicesList(t, action.services)
          })
        : t('chat.botCards.google.action.signInAgain', 'Sign in again')
    case 'continue-without':
      return t('chat.botCards.google.action.continueWithout', 'Continue without them')
    case 'keep-account':
      return t('chat.botCards.google.action.keep', 'Keep {{email}}', { email: action.email })
    case 'sign-in-again':
      return action.email
        ? t('chat.botCards.google.action.signInAs', 'Sign in as {{email}}', {
            email: action.email
          })
        : t('chat.botCards.google.action.signInAgain', 'Sign in again')
    case 'turn-on':
      return t('chat.botCards.google.action.turnOn', 'Turn on')
    case 'copy-for-admin':
      return t('chat.botCards.google.action.copyForAdmin', 'Copy for your admin')
    case 'check-again':
      return t('chat.botCards.google.action.checkAgain', 'Check again')
    case 'continue':
      return t('chat.botCards.google.action.continue', 'Continue')
    case 'start-over':
      return t('chat.botCards.google.action.startOver', 'Start over')
    case 'let-me':
      return t('chat.botCards.google.letMe', 'Let me do this one')
    case 'done':
      return t('chat.botCards.google.done', 'Done')
  }
}

export function googleSetupBlockerText(t: Translate, blocker: GoogleSetupBlocker): string {
  switch (blocker.kind) {
    case 'stopped':
      return blocker.reason
        ? t('chat.botCards.google.blocker.stoppedWhy', 'Setup stopped: {{reason}}', {
            reason: blocker.reason
          })
        : t('chat.botCards.google.blocker.stopped', 'Setup stopped.')
    case 'paused':
      return t(
        'chat.botCards.google.blocker.paused',
        'The setup paused at {{step}}. Everything so far is saved.',
        { step: googleSetupStepTitle(t, blocker.step, []) }
      )
    case 'needs-user':
      return (
        blocker.note ??
        t('chat.botCards.google.blocker.yourTurn', 'Your turn: {{step}}.', {
          step: googleSetupStepTitle(t, blocker.step, [])
        })
      )
    case 'no-key':
      return t('chat.botCards.google.blocker.noKey', 'Orca needs the app’s key first.')
    case 'key-gone':
      return t(
        'chat.botCards.google.blocker.keyGone',
        'This app’s key no longer works: it was removed in Google Cloud.'
      )
    case 'key-other-project':
      return t(
        'chat.botCards.google.blocker.keyOtherProject',
        'The saved key is for project {{keyProject}}, not {{project}}.',
        { keyProject: blocker.keyProjectId, project: blocker.projectId }
      )
    case 'other-account':
      return t(
        'chat.botCards.google.blocker.otherAccount',
        'You signed in as {{signedIn}}; this setup was for {{wanted}}.',
        { signedIn: blocker.signedIn, wanted: blocker.wanted }
      )
    case 'signed-out':
      return t('chat.botCards.google.blocker.signedOut', 'The sign-in for {{email}} ended.', {
        email: blocker.email
      })
    case 'needs-permission':
      return t(
        'chat.botCards.google.blocker.needsPermission',
        'Almost there: allow {{services}}. Google shows a box for each one; tick them all.',
        { services: googleServicesList(t, blocker.services) }
      )
    case 'api-off':
      return t(
        'chat.botCards.google.blocker.apiOff',
        '{{services}} is turned off in Google Cloud.',
        {
          services: googleServicesList(t, blocker.services)
        }
      )
    case 'admin-blocked':
      return t(
        'chat.botCards.google.blocker.adminBlocked',
        'Your company’s Google admin blocked {{services}}.',
        { services: googleServicesList(t, blocker.services) }
      )
    case 'check-failed':
      return t('chat.botCards.google.blocker.checkFailed', 'Orca couldn’t check {{services}}.', {
        services: googleServicesList(t, blocker.services)
      })
  }
}

/** The owner's three cards: how, which services, then their sign-in. */
export function googleSetupOwnerStep(t: Translate, step: 1 | 2 | 3): string {
  return t('chat.botCards.google.ownerStep', 'Step {{step}} of 3', { step })
}

/** The admin's request, as the computer copies it. */
export function googleAdminRequest(t: Translate, clientId: string): string {
  return t(
    'chat.botCards.google.adminRequest',
    'Please mark this Google app as Trusted in the Admin console (Security › API controls › Manage third-party app access): {{clientId}}',
    { clientId }
  )
}
