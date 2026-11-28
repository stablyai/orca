// The desktop's Slack row face and error words (BotSlackCard, bot-slack-copy), for the phone.
import type { Translate } from '../../i18n/mobile-i18n'
import { HOST_OFFLINE } from './bot-slack-operations'
import { slackTeamState } from '../../../../src/shared/connector-bot-slack-contract'
import type { PhoneSlackView } from './use-phone-bot-slack'

export type SlackRowFace = {
  /** The workspace's name once Slack says it. */
  workspace: string | null
  description: string
  /** A status the owner acts on, else null; `attention` when it waits on them. */
  status: { label: string; attention: boolean } | null
  /** The one thing to do next, if anything. */
  next: 'retry' | 'add' | 'finish' | 'update' | null
}

export function slackErrorMessage(code: string, hostName: string, t: Translate): string {
  switch (code) {
    case HOST_OFFLINE:
      return t('bots.items.write.offline', '{{host}} is offline.', { host: hostName })
    case 'signed_out':
      return t(
        'bots.host.errors.signedOut',
        'Sign {{host}} in to Orca Cloud to connect {{service}}.',
        {
          host: hostName,
          service: 'Slack'
        }
      )
    case 'account_changed':
      return t('bots.host.errors.accountChanged', '{{host}}’s Orca sign-in changed. Start again.', {
        host: hostName
      })
    case 'invalid_request':
      return t(
        'bots.slack.errors.notAToken',
        'That is not a configuration refresh token. It starts with xoxe-.'
      )
    case 'grant_expired':
      return t(
        'bots.slack.errors.grantExpired',
        'Slack no longer accepts this workspace’s token. Generate a new one and paste it.'
      )
    case 'rate_limited':
      return t('bots.slack.errors.rateLimited', 'Too many tries. Wait a minute, then try again.')
    case 'slack_unavailable':
      return t('bots.slack.errors.slackUnavailable', 'Slack did not answer. Try again.')
    case 'slack_refused':
      return t('bots.slack.errors.slackRefused', 'Slack refused to set up the app.')
    case 'unknown_bot':
      return t(
        'bots.slack.errors.unknownBot',
        'Orca Cloud has not seen this bot yet. Try again in a minute.'
      )
    case 'wrong_workspace':
      return t(
        'bots.slack.errors.wrongWorkspace',
        'This bot’s Slack app is in another workspace. Remove it from Slack first.'
      )
    case 'not_installed':
      return t('bots.slack.errors.notInstalled', 'Add this bot to Slack first.')
    case 'cloud_unreachable':
      return t(
        'bots.slack.errors.unreachable',
        'Orca Cloud could not be reached. Check your connection and try again.'
      )
    default:
      return t('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

export function slackRowFace(
  view: PhoneSlackView,
  teamId: string | undefined,
  hostName: string,
  t: Translate
): SlackRowFace {
  const notInstalled = {
    label: t('settings.bots.slackStatus.notInstalled', 'Not installed'),
    attention: true
  }
  if (view.status === 'loading') {
    return {
      workspace: null,
      description: t('bots.slack.setup.checking', 'Checking Slack…'),
      status: null,
      next: null
    }
  }
  if (view.status === 'failed' && view.error === 'signed_out') {
    return {
      workspace: null,
      description: t('bots.cloudSignIn.paused', 'Paused while signed out'),
      status: { label: t('bots.cloudSignIn.needsSignIn', 'Needs sign-in'), attention: false },
      next: null
    }
  }
  if (view.status === 'failed') {
    return {
      workspace: null,
      description: slackErrorMessage(view.error, hostName, t),
      status: { label: t('settings.bots.slackStatus.unknown', 'Can’t check'), attention: false },
      next: 'retry'
    }
  }
  const slack = slackTeamState(view.slack, teamId)
  switch (slack.state) {
    case 'installed':
      return {
        workspace: slack.teamName ?? slack.teamId,
        description: t('bots.slack.connection.installedBy', 'installed by {{installer}}', {
          installer: slack.installerName ?? slack.installerUserId
        }),
        status: slack.updateNeeded
          ? { label: t('settings.bots.slackStatus.updateNeeded', 'Update needed'), attention: true }
          : null,
        next: slack.updateNeeded ? 'update' : null
      }
    case 'created':
      return {
        workspace: null,
        description: t('bots.slack.connection.waiting', 'Waiting for the install in Slack.'),
        status: {
          label: t('settings.bots.slackStatus.waiting', 'Waiting for install'),
          attention: true
        },
        next: 'finish'
      }
    case 'not_created':
      return {
        workspace: null,
        description: t('bots.slack.connection.none', 'Not in Slack yet.'),
        status: notInstalled,
        next: 'add'
      }
    case 'uncertain':
    case 'grant_expired':
      return {
        workspace: null,
        description: t('bots.slack.connection.unfinished', 'Slack setup did not finish.'),
        status: notInstalled,
        next: 'finish'
      }
  }
}
