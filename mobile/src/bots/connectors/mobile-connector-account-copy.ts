// The desktop's Linear and GitHub words (bot-linear-copy, bot-github-copy, bot-host-copy), for the phone.
import { BOT_GITHUB_OFF } from '../../../../src/shared/connector-bot-github-contract'
import { BOT_LINEAR_OFF } from '../../../../src/shared/connector-bot-linear-contract'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import type { Translate } from '../../i18n/mobile-i18n'
import { HOST_OFFLINE } from './bot-slack-operations'
import { CONNECT_ON_HOST } from './connect-host-trip'
import { CONNECT_NOT_ROUTED } from './use-phone-connect-trip'

/** Google's sign-in shares only the trip's own codes (offline, not routed). */
export function connectorAccountErrorMessage(
  source: 'linear' | 'github' | 'google',
  code: string,
  hostName: string,
  t: Translate
): string {
  const service = BOT_CONNECTOR_NAMES[source]
  switch (code) {
    case HOST_OFFLINE:
      return t('bots.items.write.offline', '{{host}} is offline.', { host: hostName })
    case 'signed_out':
      return t(
        'bots.host.errors.signedOut',
        'Sign {{host}} in to Orca Cloud to connect {{service}}.',
        { host: hostName, service }
      )
    case 'account_changed':
      return t('bots.host.errors.accountChanged', '{{host}}’s Orca sign-in changed. Start again.', {
        host: hostName
      })
    case CONNECT_NOT_ROUTED:
      return t(
        'bots.host.errors.notRouted',
        '{{service}}’s page has to open in Orca’s browser for {{host}}. Reconnect {{host}}, then start again.',
        { service, host: hostName }
      )
    case CONNECT_ON_HOST:
      return t('bots.connect.finishOnHost', 'Finish connecting {{service}} in Orca on {{host}}.', {
        service,
        host: hostName
      })
    case BOT_LINEAR_OFF:
      return t('bots.linear.errors.off', 'Linear is coming soon.')
    case BOT_GITHUB_OFF:
      return t('bots.github.errors.off', 'GitHub is coming soon.')
    case 'expired':
      return source === 'linear'
        ? t(
            'bots.linear.errors.replaced',
            'Linear didn’t finish. A newer Linear or GitHub connect may have replaced it. Start again.'
          )
        : t(
            'bots.github.errors.replaced',
            'GitHub didn’t finish. A newer Linear or GitHub connect may have replaced it. Start again.'
          )
    case 'wrong_account':
      return source === 'linear'
        ? t(
            'bots.linear.errors.wrongAccount',
            'This sign-in was started from another Orca account. Connect Linear again from this one.'
          )
        : t(
            'bots.github.errors.wrongAccount',
            'This sign-in was started from another Orca account. Sign in with GitHub again from this one.'
          )
    case 'already_linked':
      return source === 'linear'
        ? t(
            'bots.linear.errors.alreadyLinked',
            'This Orca account is linked to another Linear user in that workspace. Unlink it from ⋯ on the Linear page first.'
          )
        : t(
            'bots.github.errors.alreadyLinked',
            'This Orca account is linked to another GitHub user. Unlink it from ⋯ on the GitHub page first.'
          )
    case 'not_a_member':
      return t(
        'bots.linear.errors.notAMember',
        'Only full members of the Linear workspace can pick people from it.'
      )
    case 'rate_limited':
      return t('bots.linear.errors.rateLimited', 'Too many tries. Wait a minute, then try again.')
    case 'linear_unavailable':
      return t('bots.linear.errors.unavailable', 'Linear did not answer. Try again.')
    case 'github_unavailable':
      return t('bots.github.errors.unavailable', 'GitHub did not answer. Try again.')
    case 'cloud_unreachable':
      return t(
        'bots.slack.errors.unreachable',
        'Orca Cloud could not be reached. Check your connection and try again.'
      )
    default:
      return t('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

/** A workspace as the owner recognizes it: "Stably (linear.app/stably)". */
export function linearWorkspaceLabel(name: string, urlKey: string | undefined): string {
  return urlKey ? `${name} (linear.app/${urlKey})` : name
}
