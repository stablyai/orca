import {
  BOT_IMPORT_APP_LABELS,
  type BotImportCandidate,
  type BotImportSource
} from '../../../src/shared/bots/bot-import'
import type { Translate } from '../i18n/mobile-i18n'

export type ImportPick = { source: BotImportSource; bot: BotImportCandidate }

export function pickKey(pick: ImportPick): string {
  return `${pick.source.app}:${pick.bot.agent}`
}

export function botImportPickDetail(entry: ImportPick, t: Translate): string {
  if (entry.bot.importedAs) {
    return t('bots.import.importedAs', 'imported before as {{bot}}', {
      bot: entry.bot.importedAs.name
    })
  }
  const kind =
    entry.source.app === 'hermes'
      ? entry.bot.agent === 'default'
        ? t('bots.import.defaultProfile', 'default profile')
        : t('bots.import.profile', 'profile')
      : t('bots.import.agent', 'agent')
  return t('bots.import.rowDetail', '{{app}} {{kind}}', {
    app: BOT_IMPORT_APP_LABELS[entry.source.app],
    kind
  })
}
