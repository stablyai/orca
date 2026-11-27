import type { BotGroup } from '../../../../src/shared/bots/bot-group-schema'
import { botGroupRowLine } from '../../../../src/shared/bots/bot-sidebar-entries'
import type { Translate } from '../../i18n/mobile-i18n'

/** What a bot's Needs you count is made of: "Question · access request · worker". */
export function waitsLine(
  waits: {
    asks: number
    access: number
    workers: number
    items: number
  },
  t: Translate
): string {
  const text = [
    waits.asks > 0
      ? t('home.bots.waits.questions', '{{count}} questions', {
          count: waits.asks,
          defaultValue_one: 'question'
        })
      : null,
    waits.access > 0
      ? t('home.bots.waits.access', '{{count}} access requests', {
          count: waits.access,
          defaultValue_one: 'access request'
        })
      : null,
    waits.workers > 0
      ? t('home.bots.waits.workers', '{{count}} workers', {
          count: waits.workers,
          defaultValue_one: 'worker'
        })
      : null,
    waits.items > 0
      ? t('home.bots.waits.items', '{{count}} items', {
          count: waits.items,
          defaultValue_one: 'item'
        })
      : null
  ]
    .filter(Boolean)
    .join(' · ')
  return text.charAt(0).toLocaleUpperCase() + text.slice(1)
}

/** A room's newest post, else how many are in it; its faces already show who. */
export function groupLine(
  group: BotGroup,
  members: number,
  t: Translate
): { text: string; at: number | null } {
  return group.latest
    ? botGroupRowLine(group, [], t('bots.groups.you', 'You'))
    : {
        text: t('bots.groups.memberCount', '{{count}} bots', { count: members }),
        at: null
      }
}
