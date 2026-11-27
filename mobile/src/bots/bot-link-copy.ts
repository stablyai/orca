import type { Translate } from '../i18n/mobile-i18n'
import type { StructuredSessionOpenFailure } from '../../../src/shared/agent-session/view/open-structured-agent-session'
import { BOT_ACCESS_LINK_COPY } from '../../../src/shared/bots/bot-access-link-copy'
import type { AccessRequestRedemption } from '../../../src/shared/bots/bot-link-resolution'

export const BOT_LINK_UPDATE_NOTICE = 'bots-update'

function joinHostNames(
  t: Translate,
  hostNames: readonly string[],
  intlLocale: string,
  type: 'conjunction' | 'disjunction' = 'conjunction'
): string {
  return hostNames.length > 0
    ? new Intl.ListFormat(intlLocale, { type }).format([...hostNames])
    : t('bots.link.computer', 'your computer')
}

export function botLinkUpdateNeededLine(
  t: Translate,
  hostNames: readonly string[],
  intlLocale: string
): string {
  return t('bots.link.updateNeeded', 'Update Orca on {{names}} to open this link.', {
    names: joinHostNames(t, hostNames, intlLocale)
  })
}

export function botLinkUnreachableLine(
  t: Translate,
  hostNames: readonly string[],
  intlLocale: string
): string {
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
      names: joinHostNames(
        t,
        hostNames,
        intlLocale,
        intlLocale === 'en' ? 'disjunction' : 'conjunction'
      )
    }
  )
}

export function botLinkAmbiguousLine(
  t: Translate,
  hostNames: readonly string[],
  intlLocale: string
): string {
  return t(
    'bots.link.ambiguous',
    'This bot is on {{names}}. Open the chat in Orca on the one you want.',
    { names: joinHostNames(t, hostNames, intlLocale) }
  )
}

export function botLinkMissingLine(t: Translate): string {
  return t('bots.link.missing', 'None of your paired computers has this bot.')
}

export function botLinkOfflineLine(t: Translate, name: string): string {
  return t('bots.link.offline', '{{name}} is offline. Open the link again when it’s back online.', {
    name
  })
}

export function botLinkOpenFailureLine(
  t: Translate,
  name: string,
  failure?: StructuredSessionOpenFailure
): string {
  if (failure?.reason === 'workspace-missing') {
    return t('bots.link.workspaceDeleted', 'This chat’s workspace was deleted on {{name}}.', {
      name
    })
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
