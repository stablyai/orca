import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import type { StructuredSessionOpenFailure } from '../../../src/shared/agent-session/view/open-structured-agent-session'
import { BOT_ACCESS_LINK_COPY } from '../../../src/shared/bots/bot-access-link-copy'
import type { AccessRequestRedemption } from '../../../src/shared/bots/bot-link-resolution'

export const BOT_LINK_UPDATE_NOTICE = 'bots-update'

function joinHostNames(
  hostNames: readonly string[],
  type: 'conjunction' | 'disjunction' = 'conjunction'
): string {
  return new Intl.ListFormat(getUiIntlLocale(), { type }).format([...hostNames])
}

export function botLinkUpdateNeededLine(t: Translate, hostNames: readonly string[]): string {
  if (hostNames.length === 0) {
    return t('bots.link.updateNeededUnnamed', 'Update Orca on your computer to open this link.')
  }
  return t('bots.link.updateNeeded', 'Update Orca on {{names}} to open this link.', {
    names: joinHostNames(hostNames)
  })
}

export function botLinkUnreachableLine(t: Translate, hostNames: readonly string[]): string {
  if (hostNames.length === 0) {
    return t(
      'bots.link.unreachableUnnamed',
      'Couldn’t reach your computer. Make sure Orca is running there, then try again.'
    )
  }
  if (hostNames.length === 1) {
    return t(
      'bots.link.unreachableSingle',
      'Couldn’t reach {{name}}. Make sure Orca is running there, then try again.',
      { name: hostNames[0] }
    )
  }
  return t(
    'bots.link.unreachable',
    'Couldn’t reach {{names}}. Make sure Orca is running on one, then try again.',
    {
      names: joinHostNames(hostNames, getUiIntlLocale() === 'en' ? 'disjunction' : 'conjunction')
    }
  )
}

export function botLinkAmbiguousLine(t: Translate, hostNames: readonly string[]): string {
  if (hostNames.length === 0) {
    return t(
      'bots.link.ambiguousUnnamed',
      'This bot is on more than one computer. Open the chat in Orca on the one you want.'
    )
  }
  return t(
    'bots.link.ambiguous',
    'This bot is on {{names}}. Open the chat in Orca on the one you want.',
    { names: joinHostNames(hostNames) }
  )
}

export function botLinkMissingLine(t: Translate): string {
  return t('bots.link.missing', 'None of your paired computers has this bot.')
}

export function botLinkOfflineLine(t: Translate, name: string | undefined): string {
  if (name === undefined) {
    return t(
      'bots.link.offlineUnnamed',
      'Your computer is offline. Open the link again when it’s back online.'
    )
  }
  return t('bots.link.offline', '{{name}} is offline. Open the link again when it’s back online.', {
    name
  })
}

export function botLinkOpenFailureLine(
  t: Translate,
  name: string | undefined,
  failure?: StructuredSessionOpenFailure
): string {
  if (failure?.reason === 'workspace-missing') {
    return name === undefined
      ? t(
          'bots.link.workspaceUnavailableUnnamed',
          'This chat’s workspace is no longer available on your computer.'
        )
      : t(
          'bots.link.workspaceUnavailable',
          'This chat’s workspace is no longer available on {{name}}.',
          { name }
        )
  }
  if (name === undefined) {
    return t(
      'bots.link.chatOpenFailedUnnamed',
      'Your computer couldn’t open this chat. Try the link again.'
    )
  }
  return t('bots.link.chatOpenFailed', '{{name}} couldn’t open this chat. Try the link again.', {
    name
  })
}

export function accessRequestRefusalLine(
  refusal: Exclude<AccessRequestRedemption, { kind: 'redeemed' | 'not-here' }>
): string {
  switch (refusal.kind) {
    case 'not-owner':
      return BOT_ACCESS_LINK_COPY.notOwner
    case 'expired':
      return BOT_ACCESS_LINK_COPY.expired
    case 'failed':
      return BOT_ACCESS_LINK_COPY.failed
    case 'unsupported':
      return BOT_ACCESS_LINK_COPY.unsupportedFromPhone
  }
}
