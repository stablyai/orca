// Owner notices (a banner here and a phone push) in this host's UI language, as its other
// notifications are; a headless host sends the English.
import { englishTranslate } from '../../shared/i18n/english-translate'
import { getRuntimeDesktopSurface } from '../runtime/construction/runtime-desktop-surface'

export const BOT_OWNER_NOTICE_COPY = {
  couldNotFinish: "{{bot}} couldn't finish",
  turnEnded: '"{{automation}}" ended before it finished.',
  folderMissing: '"{{automation}}" couldn\'t start because the bot\'s folder is missing.',
  sessionRefused: '"{{automation}}" couldn\'t start.',
  askedYou: '{{bot}} asked you',
  accessAsked: '{{person}} asked to use {{bot}}',
  webhookNeedsLook: "{{bot}}'s webhook needs a look",
  webhookRefusals:
    '"{{automation}}" refused {{refused}} calls in the last 10 minutes. If you don\'t expect them, pause it.',
  webhookHourlyCap:
    '"{{automation}}" reached its {{limit}} runs an hour; more calls wait. To stop them, pause it.'
} as const

export type BotOwnerNoticeCode = keyof typeof BOT_OWNER_NOTICE_COPY

export function botOwnerNoticeText(
  code: BotOwnerNoticeCode,
  values: Record<string, string | number>
): string {
  const english = BOT_OWNER_NOTICE_COPY[code]
  const translate = getRuntimeDesktopSurface().translateNotification
  return translate
    ? translate(`bots.notices.${code}`, english, values)
    : englishTranslate(code, english, values)
}
