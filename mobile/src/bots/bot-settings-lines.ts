// The one-line state under a Settings row, in the desktop's words (its bot-settings-row-states).
import { botMemberSource, type BotMember } from '../../../src/shared/bot-types'
import {
  LOOK_AROUND_EVERY_LABELS,
  lookedDay,
  type BotLookAround
} from '../../../src/shared/bots/bot-look-around'
import type { BotTidyUp } from '../../../src/shared/bots/bot-tidy-up'
import {
  CONNECTOR_SOURCE_NAMES,
  CONNECTOR_SOURCES
} from '../../../src/shared/connectors/external-conversation-link'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { translate } from '../i18n/mobile-i18n'
import { lookedWhen } from './bot-up-next-copy'

const off = (): string => translate('bots.settings.off', 'Off')

/** "Twice a day, 8 AM and 1 PM · last looked 1:02 PM". */
export function lookAroundLine(setting: BotLookAround, lastLookedAt: number | undefined): string {
  if (!setting.on) {
    return off()
  }
  const every = LOOK_AROUND_EVERY_LABELS[setting.every]
  return lastLookedAt
    ? `${every} · ${translate('bots.settings.lastLooked', 'last looked {{when}}', {
        when: lookedWhen(lastLookedAt)
      })}`
    : every
}

/** "Each night after 3 AM · last tidied today". */
export function tidyUpLine(setting: BotTidyUp, lastTidiedAt: number | undefined): string {
  if (!setting.on) {
    return off()
  }
  const every =
    setting.every === 'night'
      ? translate('bots.settings.tidyNightLine', 'Each night after 3 AM')
      : translate('bots.settings.tidyWeekLine', 'Once a week, after 3 AM')
  if (!lastTidiedAt) {
    return every
  }
  const day = lookedDay(lastTidiedAt, Date.now())
  const when =
    day === 'today'
      ? translate('bots.settings.today', 'today')
      : day === 'yesterday'
        ? translate('bots.settings.yesterday', 'yesterday')
        : new Intl.DateTimeFormat(getUiIntlLocale(), { month: 'short', day: 'numeric' }).format(
            lastTidiedAt
          )
  return `${every} · ${translate('bots.settings.lastTidied', 'last tidied {{when}}', { when })}`
}

/** "Slack 2 people with access · 1 request"; "Only you" with nobody added. */
export function whoCanAskLine(members: readonly BotMember[], requests: number): string {
  const parts = CONNECTOR_SOURCES.flatMap((source) => {
    const people = members.filter((member) => botMemberSource(member) === source).length
    return people > 0
      ? [
          translate('bots.settings.withAccess', '{{service}} {{people}} with access', {
            service: CONNECTOR_SOURCE_NAMES[source],
            people
          })
        ]
      : []
  })
  if (requests > 0) {
    parts.push(
      translate('bots.settings.requests', '{{count}} requests', {
        count: requests,
        defaultValue_one: '{{count}} request'
      })
    )
  }
  return parts.length > 0 ? parts.join(' · ') : translate('bots.settings.onlyYou', 'Only you')
}
