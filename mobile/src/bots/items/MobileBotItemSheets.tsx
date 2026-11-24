// The sheets an item opens over the bot panel: a row's long-press actions (the desktop's hover ✓ and ⋯),
// the status picker, Move to for a selection, Waiting with what it waits on, Stale's Cancel all, and
// Snooze. Cancel, like every other move, happens at once.
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
  BOT_ITEM_LIMITS,
  botItemPickerStatuses,
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
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../../src/shared/bot-runtime-capabilities'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import {
  MobileBotItemSnoozeSheets,
  snoozeAction,
  type BotItemSnoozeSheet
} from './MobileBotItemSnoozeSheets'

export type BotItemSheet =
  | { kind: 'row'; item: BotItem }
  | { kind: 'status'; item: BotItem }
  | { kind: 'move'; items: readonly BotItem[] }
  | { kind: 'wait'; items: readonly BotItem[] }
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
  pick: (status: BotItemStatus) => void,
  waiting: boolean
): ActionSheetAction[] {
  return botItemPickerStatuses(waiting).map((status) => ({
    id: status,
    label: botItemStatusName(status, t),
    renderIcon: () => <MobileBotItemStatusIcon status={status} size={12} />,
    checked: status === current,
    // Waiting opens its note sheet once this one has gone.
    closeBeforePress: status === 'waiting',
    onPress: () => {
      // Waiting again edits what it waits on.
      if (status !== current || status === 'waiting') {
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
  /** The host answers: off, what Waiting waits on is kept until it does. */
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
  const waiting = useRouteCapability(BOTS_ITEM_WAITING_CAPABILITY)
  const close = () => setSheet(null)
  const toStatus = (items: readonly BotItem[]) => (status: BotItemStatus) =>
    status === 'waiting' ? setSheet({ kind: 'wait', items }) : void move(items, status)

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
                onPress: () => void move([row], 'canceled')
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
                ...statusActions(status.status, t, toStatus([status]), waiting),
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
            ? [
                ...statusActions(null, t, toStatus(moving), waiting),
                ...snoozeAction(moving, t, setSheet)
              ]
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
      <WaitNoteSheet
        items={sheet?.kind === 'wait' ? sheet.items : null}
        online={online}
        hostName={hostName}
        onClose={close}
        onDone={async (items, note) => {
          if (await move(items, 'waiting', note)) {
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

/** Waiting with what it waits on. The text stays in the field until the host takes it. */
function WaitNoteSheet({
  items,
  online,
  hostName,
  onClose,
  onDone
}: {
  items: readonly BotItem[] | null
  online: boolean
  hostName: string
  onClose: () => void
  onDone: (items: readonly BotItem[], note: string) => Promise<boolean>
}) {
  const t = useMobileTranslation()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<readonly BotItem[] | null>(null)
  // A new ask starts empty; the same one keeps what was typed.
  if (items !== shown) {
    setShown(items)
    if (items !== null) {
      // Waiting again on one Waiting item starts from what it waits on.
      const [only] = items
      setNote((items.length === 1 && only?.wait?.text) || '')
    }
  }
  const count = items?.length ?? 0
  const title = items?.[0]?.title ?? ''
  return (
    <BottomDrawer visible={items !== null} onClose={onClose}>
      <TextInputSheetContent
        title={
          count > 1
            ? t('bots.items.wait.titleMany', 'What are {{count}} items waiting on?', { count })
            : t('bots.items.wait.titleOne', 'What is {{title}} waiting on?', { title })
        }
        value={note}
        onChangeText={(text) => setNote(text.slice(0, BOT_ITEM_LIMITS.wait))}
        placeholder={t('bots.items.wait.placeholder', 'Waiting on')}
        cancelLabel={t('bots.items.wait.keep', 'Cancel')}
        submitLabel={t('bots.items.wait.confirm', 'Set Waiting')}
        busy={busy}
        submitBlocked={!online}
        notice={
          online
            ? null
            : {
                icon: WifiOff,
                text: t(
                  'bots.items.wait.offline',
                  '{{host}} is offline. What you typed is kept; Set Waiting works again when it’s back.',
                  { host: hostName }
                )
              }
        }
        onSubmit={(text) => {
          if (!items) {
            return
          }
          setBusy(true)
          void onDone(items, text).then(() => setBusy(false))
        }}
        onCancel={onClose}
      />
    </BottomDrawer>
  )
}
