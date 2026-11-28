// The phone's words for where the Google setup is stuck and its buttons, as google-setup-blocker-copy.
import {
  GOOGLE_SETUP_ALLOW_NAMES_UP_TO,
  type GoogleSetupAction,
  type GoogleSetupBlocker
} from '../../../../../../src/shared/google/google-setup-blocker'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { googleServicesList, googleSetupStepTitle } from './mobile-google-setup-copy'

export function googleSetupActionText(
  t: Translate,
  locale: string,
  action: GoogleSetupAction
): string {
  switch (action.id) {
    case 'make-new-key':
      return t('chat.botCards.google.action.makeNewKey', 'Make a new key')
    case 'import-key':
      return t('chat.botCards.google.action.importKey', 'Import a key file')
    case 'allow':
      return action.services.length <= GOOGLE_SETUP_ALLOW_NAMES_UP_TO
        ? t('chat.botCards.google.action.allow', 'Allow {{services}}', {
            services: googleServicesList(t, locale, action.services)
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

export function googleSetupBlockerText(
  t: Translate,
  locale: string,
  blocker: GoogleSetupBlocker
): string {
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
        { step: googleSetupStepTitle(t, locale, blocker.step, []) }
      )
    case 'needs-user':
      return (
        blocker.note ??
        t('chat.botCards.google.blocker.yourTurn', 'Your turn: {{step}}.', {
          step: googleSetupStepTitle(t, locale, blocker.step, [])
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
        { services: googleServicesList(t, locale, blocker.services) }
      )
    case 'api-off':
      return t(
        'chat.botCards.google.blocker.apiOff',
        '{{services}} is turned off in Google Cloud.',
        {
          services: googleServicesList(t, locale, blocker.services)
        }
      )
    case 'admin-blocked':
      return t(
        'chat.botCards.google.blocker.adminBlocked',
        'Your company’s Google admin blocked {{services}}.',
        { services: googleServicesList(t, locale, blocker.services) }
      )
    case 'check-failed':
      return t('chat.botCards.google.blocker.checkFailed', 'Orca couldn’t check {{services}}.', {
        services: googleServicesList(t, locale, blocker.services)
      })
  }
}

/** The admin's request, as the computer copies it. */
export function googleAdminRequest(t: Translate, clientId: string): string {
  return t(
    'chat.botCards.google.adminRequest',
    'Please mark this Google app as Trusted in the Admin console (Security › API controls › Manage third-party app access): {{clientId}}',
    { clientId }
  )
}
