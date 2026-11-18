// The owner's status changes and snoozes from the phone: one call per action (a bulk move too), one mail
// per move and none for a snooze. The toast names what happened; a failed move keeps the selection, and a
// dropped connection says the change may have landed rather than retrying.
import { useState } from 'react'
import type { BotItem, BotItemStatus } from '../../../../src/shared/bots/bot-items'
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { triggerError } from '../../platform/haptics/haptics'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { setBotItemsStatus, snoozeBotItems, type BotItemWriteOutcome } from './bot-item-operations'
import { formatPhoneSnoozeTime } from './bot-item-snooze-time'

export type BotItemMoves = {
  /** Resolves true once the host took the change. */
  move: (items: readonly BotItem[], to: BotItemStatus, reason?: string) => Promise<boolean>
  /** Snoozes until `until`, or brings back with null; resolves true once the host took it. */
  snooze: (items: readonly BotItem[], until: number | null) => Promise<boolean>
  busy: boolean
}

export function useBotItemMoves({
  client,
  hostName,
  showToast
}: {
  client: RpcClient | null
  hostName: string
  showToast: (message: string) => void
}): BotItemMoves {
  const t = useMobileTranslation()
  const [busy, setBusy] = useState(false)
  const send = async (
    write: (client: RpcClient) => Promise<BotItemWriteOutcome>
  ): Promise<BotItemWriteOutcome> => {
    if (!client) {
      return { kind: 'not-sent' }
    }
    setBusy(true)
    const result = await write(client)
    setBusy(false)
    return result
  }
  const move = async (items: readonly BotItem[], to: BotItemStatus, reason?: string) => {
    const outcome = await send((rpc) =>
      setBotItemsStatus(
        rpc,
        items.map((item) => item.uid),
        to,
        reason
      )
    )
    if (outcome.kind === 'done') {
      showToast(movedText(items, to, t))
      return true
    }
    triggerError()
    showToast(failedMoveText(items, to, outcome, hostName, t))
    return false
  }
  const snooze = async (items: readonly BotItem[], until: number | null) => {
    const outcome = await send((rpc) => snoozeBotItems(rpc, items, until))
    if (outcome.kind === 'done') {
      showToast(snoozedText(items, until, t))
      return true
    }
    triggerError()
    const why = botItemWriteFailure(outcome, hostName, t)
    showToast(
      outcome.kind === 'unknown'
        ? why
        : t('bots.items.toast.snoozeFailed', 'Couldn’t snooze: {{why}}', { why })
    )
    return false
  }
  return { move, snooze, busy }
}

function snoozedText(items: readonly BotItem[], until: number | null, t: Translate): string {
  const [only] = items
  const when = until === null ? '' : formatPhoneSnoozeTime(until, Date.now())
  if (items.length === 1 && only) {
    return until === null
      ? t('bots.items.toast.unsnoozedOne', 'Unsnoozed {{title}}', { title: only.title })
      : t('bots.items.toast.snoozedOne', 'Snoozed {{title}} until {{when}}', {
          title: only.title,
          when
        })
  }
  return until === null
    ? t('bots.items.toast.unsnoozedMany', 'Unsnoozed {{count}} items', { count: items.length })
    : t('bots.items.toast.snoozedMany', 'Snoozed {{count}} items until {{when}}', {
        count: items.length,
        when
      })
}

function movedText(items: readonly BotItem[], to: BotItemStatus, t: Translate): string {
  const [only] = items
  if (items.length === 1 && only) {
    return to === 'done'
      ? t('bots.items.toast.markedDone', 'Marked {{title}} done', { title: only.title })
      : to === 'canceled'
        ? t('bots.items.toast.canceledOne', 'Canceled {{title}}', { title: only.title })
        : t('bots.items.toast.movedOne', 'Moved {{title}} to {{status}}', {
            title: only.title,
            status: botItemStatusName(to, t)
          })
  }
  return t('bots.items.toast.movedMany', 'Moved {{count}} items to {{status}}', {
    count: items.length,
    status: botItemStatusName(to, t)
  })
}

/** Why a move didn't land, in the words the toast uses. */
export function botItemWriteFailure(
  outcome: Exclude<BotItemWriteOutcome, { kind: 'done' }>,
  hostName: string,
  t: Translate
): string {
  switch (outcome.kind) {
    case 'refused':
      return outcome.message
    case 'unknown':
      return t(
        'bots.items.write.unknown',
        'The connection dropped while sending, so it may have arrived. Check Activity after it reconnects before sending again.'
      )
    case 'not-sent':
      return t('bots.items.write.offline', '{{host}} is offline.', { host: hostName })
  }
}

function failedMoveText(
  items: readonly BotItem[],
  to: BotItemStatus,
  outcome: Exclude<BotItemWriteOutcome, { kind: 'done' }>,
  hostName: string,
  t: Translate
): string {
  const why = botItemWriteFailure(outcome, hostName, t)
  if (outcome.kind === 'unknown') {
    return why
  }
  return items.length === 1 && to === 'done'
    ? t('bots.items.toast.doneFailed', 'Couldn’t mark it done: {{why}}', { why })
    : t('bots.items.toast.moveFailed', 'Couldn’t move {{count}} items: {{why}}', {
        count: items.length,
        why,
        defaultValue_one: 'Couldn’t move it: {{why}}'
      })
}
