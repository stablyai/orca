// The one-line state under a Settings row; Look around and Memory upkeep share the desktop's lines.
import { botMemberSource, type BotMember } from '../../../src/shared/bot-types'
import type { BotLookAround } from '../../../src/shared/bots/bot-look-around'
import {
  botLookAroundLine,
  botTidyUpLine,
  type BotSettingsLineWords
} from '../../../src/shared/bots/bot-settings-row-lines'
import type { BotTidyUp } from '../../../src/shared/bots/bot-tidy-up'
import {
  CONNECTOR_SOURCE_NAMES,
  CONNECTOR_SOURCES
} from '../../../src/shared/connectors/external-conversation-link'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { translate } from '../i18n/mobile-i18n'

const LINE_WORDS: BotSettingsLineWords = {
  t: translate,
  format: (at, options) => new Intl.DateTimeFormat(getUiIntlLocale(), options).format(at)
}

/** "Twice a day, 8 AM and 1 PM · last looked 1:02 PM". */
export function lookAroundLine(setting: BotLookAround, lastLookedAt: number | undefined): string {
  return botLookAroundLine(setting, lastLookedAt, LINE_WORDS)
}

/** "Each night after 3 AM · last tidied today". */
export function tidyUpLine(setting: BotTidyUp, lastTidiedAt: number | undefined): string {
  return botTidyUpLine(setting, lastTidiedAt, {
    ...LINE_WORDS,
    tidyEvery: (every) =>
      every === 'night'
        ? translate('bots.settings.tidyNightLine', 'Each night after 3 AM')
        : translate('bots.settings.tidyWeekLine', 'Once a week, after 3 AM')
  })
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
