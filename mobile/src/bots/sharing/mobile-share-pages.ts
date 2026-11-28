// Share bot's pages on the phone and the words their rows share: which page shows a flag, and when
// an automation runs.
import type { BotShareFlagSpot } from '../../../../src/shared/bots/bot-share-flag-spots'
import { automationEventKind } from '../../../../src/shared/automation-event-triggers'
import { formatAutomationSchedule } from '../../automations/automation-schedule-label'
import type { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { eventLabel } from '../mobile-bot-sheet-copy'
import type { PhoneShareCandidate, PhoneShareSelection } from './bot-share-operations'

export type ShareList =
  | 'skills'
  | 'automations'
  | 'tools'
  | 'memory'
  | 'note'
  | 'check'
  | 'notIncluded'

export type SharePartPage = {
  kind: 'part'
  part: string
  title: string
  detail?: string
  showNames?: boolean
}

export type SharePage = { kind: 'list'; list: ShareList } | SharePartPage

export type ShareContext = {
  client: RpcClient | null
  botId: string
  candidate: PhoneShareCandidate
  selection: PhoneShareSelection
  select: (change: Partial<PhoneShareSelection>) => void
  spots: BotShareFlagSpot[]
  open: (page: SharePage) => void
  note: string
  setNote: (note: string) => void
}

export function shareListTitle(list: ShareList, t: ReturnType<typeof useMobileTranslation>) {
  const titles: Record<ShareList, string> = {
    skills: t('bots.share.skills', 'Skills'),
    automations: t('bots.share.automations', 'Automations'),
    tools: t('bots.share.tools', 'Tools'),
    memory: t('bots.share.memory', 'Memory'),
    note: t('bots.share.setupNote', 'Setup note'),
    check: t('bots.share.safetyCheck', 'Safety check'),
    notIncluded: t('bots.share.notIncluded', 'Not included')
  }
  return titles[list]
}

/** The page that shows a flag's text; null when nothing shows it. */
export function shareFlagPage(
  spot: BotShareFlagSpot,
  t: ReturnType<typeof useMobileTranslation>
): SharePartPage | null {
  if (!spot.part) {
    return null
  }
  return {
    kind: 'part',
    part: spot.part,
    title: spot.where,
    ...(spot.part.startsWith('memory:')
      ? { detail: t('bots.share.memory', 'Memory') }
      : { showNames: spot.part.startsWith('skill:') })
  }
}

export function scheduleWhen(
  rrule: string,
  t: ReturnType<typeof useMobileTranslation>,
  locale: string
): string {
  return formatAutomationSchedule(rrule, t, locale)
}

export function eventWhen(
  source: string,
  event: string,
  t: ReturnType<typeof useMobileTranslation>
): string {
  return automationEventKind(source, event) ? eventLabel({ source, event }, t) : event
}

/** One automation can start on several events; it is ticked and shown once. */
export function uniqueEvents<Event extends { automationId: string }>(events: readonly Event[]) {
  return events.filter(
    (entry, index) => events.findIndex((e) => e.automationId === entry.automationId) === index
  )
}

/** Why an item stays out of the link, as its row says. */
export function notShared(why: string, t: ReturnType<typeof useMobileTranslation>): string {
  switch (why) {
    case 'webhook':
      return t('bots.share.webhookNotShared', 'Webhook · not shared')
    case 'command':
      return t('bots.share.commandNotShared', 'Command · not shared')
    case 'link':
      return t('bots.share.fileLinkNotShared', 'Has a symlink or hard link · not shared')
    case 'size':
      return t('bots.share.tooLargeNotShared', 'Too large · not shared')
    case 'unreadable':
      return t('bots.share.unreadableNotShared', 'Can’t be read · not shared')
    case 'limit':
      return t('bots.share.overLimitNotShared', 'Over the skill limit · not shared')
    default:
      return t('bots.share.notShared', 'Not shared')
  }
}
