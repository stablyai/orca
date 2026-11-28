// The desktop's share words on the phone: refusals, flag labels and the safety check's summary.
import {
  BOT_SHARE_ERRORS,
  type BotShareErrorCode
} from '../../../../src/shared/bots/bot-share-errors'
import type { BotShareFlag } from '../../../../src/shared/bots/bot-package'
import type { BotShareFlagSpot } from '../../../../src/shared/bots/bot-share-flag-spots'
import { translate, type Translate } from '../../i18n/mobile-i18n'
import { botShareErrorCode } from './bot-share-operations'

function copyFor(code: BotShareErrorCode): string {
  switch (code) {
    case BOT_SHARE_ERRORS.blocked:
      return translate(
        'bots.share.error.blocked',
        'A secret was found in what would be shared. Remove it, then try again.'
      )
    case BOT_SHARE_ERRORS.noteSecret:
      return translate(
        'bots.share.error.noteSecret',
        'The setup note looks like it holds a secret. Remove it, then try again.'
      )
    case BOT_SHARE_ERRORS.expired:
      return translate(
        'bots.share.error.expired',
        'This share preview expired. Open Share bot again.'
      )
    case BOT_SHARE_ERRORS.prepareAgain:
      return translate(
        'bots.share.error.prepareAgain',
        'This bot was shared from another window meanwhile. Open Share bot again.'
      )
    case BOT_SHARE_ERRORS.stopped:
      return translate(
        'bots.share.error.stopped',
        'This link was stopped. Publish to make a new link.'
      )
    case BOT_SHARE_ERRORS.moved:
      return translate(
        'bots.share.error.moved',
        'This link was updated somewhere else. Open Share bot again to see it.'
      )
    case BOT_SHARE_ERRORS.unavailable:
      return translate('bots.share.error.unavailable', 'Orca Cloud doesn’t accept bot shares yet.')
    case BOT_SHARE_ERRORS.avatarRefused:
      return translate(
        'bots.share.error.avatarRefused',
        'Orca Cloud refused the bot’s picture. Pick another picture, then try again.'
      )
    case BOT_SHARE_ERRORS.tooLarge:
      return translate(
        'bots.share.error.tooLarge',
        'This bot is too large to share. Leave out some memory or skills, then try again.'
      )
    case BOT_SHARE_ERRORS.signIn:
      return translate('bots.share.signIn', 'Sign in to Orca to share.')
    case BOT_SHARE_ERRORS.reconnect:
      return translate('bots.share.reconnect', 'Sign in to Orca again to share.')
  }
}

export function botShareErrorMessage(cause: unknown): string {
  const code = botShareErrorCode(cause)
  if (code) {
    return copyFor(code)
  }
  if (cause instanceof Error && cause.message === 'bot_name_taken') {
    return translate('bots.settings.nameTaken', 'Another bot already has that name.')
  }
  // Unlike the desktop, the phone has no log to read: the computer's own reason is shown.
  return cause instanceof Error && cause.message
    ? cause.message
    : translate('bots.errors.generic', 'Something went wrong. Try again.')
}

export function botShareFlagLabel(kind: BotShareFlag['kind'], t: Translate): string {
  switch (kind) {
    case 'secret':
      return t('bots.share.flag.secret', 'Secret')
    case 'pipe-to-shell':
      return t('bots.share.flag.pipeToShell', 'Runs a downloaded script')
    case 'sudo':
      return t('bots.share.flag.sudo', 'Runs as administrator')
    case 'sends-file':
      return t('bots.share.flag.sendsFile', 'Sends a file')
    case 'hidden-unicode':
      return t('bots.share.flag.hiddenUnicode', 'Hidden characters')
    case 'runnable':
      return t('bots.share.flag.runnable', 'Runnable file')
  }
}

/** The safety check's one-line value: a secret first, then warnings, else nothing. */
export function botShareCheckSummary(spots: readonly BotShareFlagSpot[], t: Translate): string {
  const secrets = spots.filter((spot) => spot.flag.kind === 'secret').length
  if (secrets > 0) {
    return secrets === 1
      ? t('bots.share.secretFound', '1 secret found')
      : t('bots.share.secretsFound', '{{count}} secrets found', { count: secrets })
  }
  if (spots.length > 0) {
    return spots.length === 1
      ? t('bots.share.oneWarning', '1 warning')
      : t('bots.share.warnings', '{{count}} warnings', { count: spots.length })
  }
  return t('bots.share.nothingFound', 'Nothing found')
}

/** "release-process, line 6": where a flag is, for its row. */
export function botShareFlagWhere(spot: BotShareFlagSpot, t: Translate): string {
  return spot.flag.line === null
    ? spot.where
    : t('bots.share.whereLine', '{{where}}, line {{line}}', {
        where: spot.where,
        line: spot.flag.line
      })
}

export function botShareLines(count: number, t: Translate): string {
  return count === 1
    ? t('bots.share.oneLine', '1 line')
    : t('bots.share.lines', '{{count}} lines', { count })
}

/** "Nov 9", or with `time` "Nov 9, 3:12 PM": when a link was made or last changed. */
export function botShareDate(iso: string | null, intlLocale: string, time = false): string {
  const date = iso ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat(intlLocale, {
        month: 'short',
        day: 'numeric',
        ...(time ? { hour: 'numeric', minute: '2-digit' } : {})
      }).format(date)
    : ''
}

/** A link without its scheme, as the desktop shows it. */
export function botShareUrlText(url: string): string {
  return url.replace(/^https:\/\//, '')
}
