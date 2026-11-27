// The shared Who can ask and Request access wording in the phone's language; the shared table's
// English is each key's fallback, and the desktop's bots.access keys carry the translations.
import {
  BOT_ACCESS_COPY,
  botAccessPlace,
  type BotAccessCopyId,
  type BotAccessHost
} from '../../../src/shared/bots/bot-access-copy'
import type { Translate } from '../i18n/mobile-i18n'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'

export function mobileBotAccessCopy(
  t: Translate,
  id: BotAccessCopyId,
  values: Record<string, string | number> = {}
): string {
  return t(`bots.access.${id}`, BOT_ACCESS_COPY[id], values)
}

/** {{computer}} and {{there}} for the bot's host, in the phone's language. */
export function mobileBotAccessPlace(
  t: Translate,
  host: BotAccessHost
): { computer: string; there: string } {
  return botAccessPlace(host, (id) => mobileBotAccessCopy(t, id))
}

/** People named in this copy: narrow lists keep English "a, b" and give CJK its own comma. */
export function mobileBotAccessNames(names: readonly string[]): string {
  return new Intl.ListFormat(getUiIntlLocale(), { type: 'conjunction', style: 'narrow' }).format(
    names
  )
}
