// The words an item's Activity lines put in: a changed field's name and a status, as the desktop says them.
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import { BOT_ITEM_STATUSES } from '../../../../src/shared/bots/bot-items'
import type { Translate } from '../../i18n/mobile-i18n'

export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function fieldName(field: string, t: Translate): string {
  return field === 'doneMeans'
    ? t('bots.items.field.doneMeansLower', 'done means')
    : field === 'description'
      ? t('bots.items.field.description', 'description')
      : t('bots.items.field.title', 'title')
}

export function statusWord(value: unknown, t: Translate): string {
  const status = BOT_ITEM_STATUSES.find((entry) => entry === value)
  return status ? botItemStatusName(status, t) : str(value)
}
