// The sheets an item opens over the bot panel: a row's long-press actions (the desktop's hover ✓ and ⋯),
// the status picker, Move to for a selection, Cancel with one reason, Stale's Cancel all, and Snooze.
import { useState } from 'react'
import {
  CircleCheck,
  CircleSlash,
  House,
  ListChecks,
  MessageSquare,
  Shuffle,
  WifiOff
} from '../../components/icons/app-icons'
import {
  BOT_ITEM_STATUSES,
  isOpenBotItemStatus,
  type BotItem,
  type BotItemStatus
} from '../../../../src/shared/bots/bot-items'
import { botItemStatusName } from '../../../../src/shared/bots/bot-item-status-name'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { ActionSheetModal, type ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import { TextInputSheetContent } from '../../components/sheets/TextInputModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { MobileBotItemStatusIcon } from './MobileBotItemStatusIcon'
import {
  MobileBotItemSnoozeSheets,
  snoozeAction,
  type BotItemSnoozeSheet
} from './MobileBotItemSnoozeSheets'

export type BotItemSheet =
  | { kind: 'row'; item: BotItem }
  | { kind: 'status'; item: BotItem }
  | { kind: 'move'; items: readonly BotItem[] }
  | { kind: 'cancel'; items: readonly BotItem[] }
  | { kind: 'stale'; items: readonly BotItem[]; reason: string }
  | BotItemSnoozeSheet

export function botItemChatName(item: BotItem, t: Translate): string {
  return item.chat.kind === 'home'
    ? t('bots.items.homeChat', 'Home Chat')
    : (item.chat.title ?? t('bots.items.chatFallback', 'Chat'))
}

function statusActions(
  current: BotItemStatus | null,
  t: Translate,
  pick: (status: BotItemStatus) => void
): ActionSheetAction[] {
  return BOT_ITEM_STATUSES.map((status) => ({
    id: status,
    label: botItemStatusName(status, t),
    renderIcon: () => <MobileBotItemStatusIcon status={status} size={12} />,
    checked: status === current,
    // Canceled opens the reason sheet once this one has gone.
    closeBeforePress: status === 'canceled',
    onPress: () => {
      if (status !== current) {
        pick(status)
      }
    }
  }))
}

export function MobileBotItemSheets({
  sheet,
  setSheet,
  online,
  hostName,
  onSelect,
  onOpenChat,
  move,
  snooze
}: {
  sheet: BotItemSheet | null
  setSheet: (sheet: BotItemSheet | null) => void
  /** The host answers: off, a reason is kept and Cancel waits for it. */
  online: boolean
  hostName: string
  /** Long-press → Select starts multi-select with this row checked. */
  onSelect: ((item: BotItem) => void) | null
  onOpenChat: (item: BotItem) => void
  /** Resolves true once the host took the change. */
  move: (items: readonly BotItem[], to: BotItemStatus, reason?: string) => Promise<boolean>
  /** Snoozes until a time, or brings back with null; resolves true once the host took it. */
  snooze: (items: readonly BotItem[], until: number | null) => Promise<boolean>
}) {
  const t = useMobileTranslation()
  const close = () => setSheet(null)
  const toStatus = (items: readonly BotItem[]) => (status: BotItemStatus) =>
    status === 'canceled' ? setSheet({ kind: 'cancel', items }) : void move(items, status)

  const row = sheet?.kind === 'row' ? sheet.item : null
  const rowActions: ActionSheetAction[] = row
    ? [
        ...(onSelect
          ? [
              {
                id: 'select',
                label: t('bots.items.menu.select', 'Select'),
                icon: ListChecks,
                onPress: () => onSelect(row)
              }
            ]
          : []),
        ...(isOpenBotItemStatus(row.status)
          ? [
              {
                id: 'done',
                label: t('bots.items.menu.done', 'Done'),
                icon: CircleCheck,
                onPress: () => void move([row], 'done')
              }
            ]
          : []),
        {
          id: 'status',
          label: t('bots.items.menu.changeStatus', 'Change status'),
          icon: Shuffle,
          closeBeforePress: true,
          onPress: () => setSheet({ kind: 'status', item: row })
        },
        ...snoozeAction([row], t, setSheet),
        {
          id: 'chat',
          label: t('bots.items.menu.openChat', 'Open {{chat}}', { chat: botItemChatName(row, t) }),
          icon: row.chat.kind === 'home' ? House : MessageSquare,
          closeBeforePress: true,
          onPress: () => onOpenChat(row)
        },
        ...(isOpenBotItemStatus(row.status)
          ? [
              {
                id: 'cancel',
                label: t('bots.items.menu.cancelShort', 'Cancel'),
                icon: CircleSlash,
                closeBeforePress: true,
                onPress: () => setSheet({ kind: 'cancel', items: [row] })
              }
            ]
          : [])
      ]
    : []

  const status = sheet?.kind === 'status' ? sheet.item : null
  const moving = sheet?.kind === 'move' ? sheet.items : null
  const stale = sheet?.kind === 'stale' ? sheet : null
  return (
    <>
      <ActionSheetModal
        visible={row !== null}
        title={row?.title}
        actions={rowActions}
        onClose={() => setSheet(sheet?.kind === 'row' ? null : sheet)}
      />
      <ActionSheetModal
        visible={status !== null}
        title={t('bots.items.field.status', 'Status')}
        actions={
          status
            ? [
                ...statusActions(status.status, t, toStatus([status])),
                ...snoozeAction([status], t, setSheet)
              ]
            : []
        }
        onClose={() => setSheet(sheet?.kind === 'status' ? null : sheet)}
      />
      <ActionSheetModal
        visible={moving !== null}
        title={t('bots.items.pill.moveCount', 'Move {{count}} items to', {
          count: moving?.length ?? 0,
          defaultValue_one: 'Move {{count}} item to'
        })}
        actions={
          moving
            ? [...statusActions(null, t, toStatus(moving)), ...snoozeAction(moving, t, setSheet)]
            : []
        }
        onClose={() => setSheet(sheet?.kind === 'move' ? null : sheet)}
      />
      <MobileBotItemSnoozeSheets
        sheet={
          sheet?.kind === 'snooze' || sheet?.kind === 'snooze-day' || sheet?.kind === 'snooze-hour'
            ? sheet
            : null
        }
        setSheet={setSheet}
        snooze={snooze}
      />
      <CancelReasonSheet
        items={sheet?.kind === 'cancel' ? sheet.items : null}
        online={online}
        hostName={hostName}
        onClose={close}
        onCancel={async (items, reason) => {
          if (await move(items, 'canceled', reason)) {
            close()
            return true
          }
          return false
        }}
      />
      <ConfirmModal
        visible={stale !== null}
        title={t('bots.items.stale.confirm', 'Cancel {{count}} stale items?', {
          count: stale?.items.length ?? 0,
          defaultValue_one: 'Cancel {{count}} stale item?'
        })}
        message={t(
          'bots.items.stale.confirmWhy',
          'Reason sent to the bot: “{{reason}}” Nothing is deleted.',
          { reason: stale?.reason ?? '' }
        )}
        cancelLabel={t('bots.items.cancel.keep', 'Keep')}
        confirmLabel={t('bots.items.cancel.confirmMany', 'Cancel {{count}}', {
          count: stale?.items.length ?? 0
        })}
        onConfirm={() => {
          if (stale) {
            void move(stale.items, 'canceled', stale.reason)
          }
        }}
        onCancel={close}
      />
    </>
  )
}

/** Cancel with a reason the bot sees. The reason stays in the field until the host takes it. */
function CancelReasonSheet({
  items,
  online,
  hostName,
  onClose,
  onCancel
}: {
  items: readonly BotItem[] | null
  online: boolean
  hostName: string
  onClose: () => void
  onCancel: (items: readonly BotItem[], reason: string) => Promise<boolean>
}) {
  const t = useMobileTranslation()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<readonly BotItem[] | null>(null)
  // A new ask starts empty; the same one keeps what was typed.
  if (items !== shown) {
    setShown(items)
    if (items !== null) {
      setReason('')
    }
  }
  const [first] = items ?? []
  const many = (items?.length ?? 0) > 1
  return (
    <BottomDrawer visible={items !== null} onClose={onClose}>
      <TextInputSheetContent
        title={
          many
            ? t('bots.items.cancel.titleMany', 'Cancel {{count}} items?', { count: items?.length })
            : t('bots.items.cancel.titleOne', 'Cancel {{title}}?', { title: first?.title ?? '' })
        }
        message={t('bots.items.cancel.why', 'The bot sees the reason. Nothing is deleted.')}
        value={reason}
        onChangeText={setReason}
        placeholder={t('bots.items.cancel.placeholder', 'Reason')}
        cancelLabel={t('bots.items.cancel.keep', 'Keep')}
        submitLabel={
          many
            ? t('bots.items.cancel.confirmMany', 'Cancel {{count}}', { count: items?.length })
            : t('bots.items.cancel.confirmOne', 'Cancel item')
        }
        busy={busy}
        submitBlocked={!online}
        notice={
          online
            ? null
            : {
                icon: WifiOff,
                text: t(
                  'bots.items.cancel.offline',
                  '{{host}} is offline. Your reason is kept; {{action}} works again when it’s back.',
                  {
                    host: hostName,
                    action: many
                      ? t('bots.items.cancel.confirmMany', 'Cancel {{count}}', {
                          count: items?.length
                        })
                      : t('bots.items.cancel.confirmOne', 'Cancel item')
                  }
                )
              }
        }
        onSubmit={(text) => {
          if (!items) {
            return
          }
          setBusy(true)
          void onCancel(items, text).then(() => setBusy(false))
        }}
        onCancel={onClose}
      />
    </BottomDrawer>
  )
}
