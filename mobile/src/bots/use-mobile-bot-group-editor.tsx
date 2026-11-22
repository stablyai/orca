import { useState, type ReactNode } from 'react'
import { Alert } from 'react-native'
import { BOTS_GROUPS_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import type { HostScreenController } from '../host-screen/use-host-screen-controller'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { hostBotsKey, readHostBots } from './host-bots-read'
import type { PhoneBot } from './host-bots-operations'
import { confirmMobileBotGroupDelete } from './mobile-bot-group-delete'
import { MobileBotGroupMembers } from './MobileBotGroupMembers'
import { MobileBotsReorderSheet } from './MobileBotsReorderSheet'
import type { ListedHostBots } from './host-bot-listing'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host/execution-host'
import { botCreateMenuActions, botGroupMenuActions } from './bot-group-menu-actions'

export type MobileBotGroupEditor = {
  /** The paired host makes groups, so the Bots "+" offers New group beside New bot. */
  supported: boolean
  /** The Bots "+": New bot, and New group where the host makes them, as the desktop's menu. */
  chooseNew: (newBot: () => void, botCount: number) => void
  /** A group row's long press: Manage members and Delete, as the desktop's row menu. */
  showActions: (group: BotGroup) => void
  open: (group: Pick<BotGroup, 'id'>) => void
  sheets: ReactNode
}

/** New group, a group's menu and its members sheet, for the paired host's groups in the Bots list. */
export function useMobileBotGroupEditor(controller: HostScreenController): MobileBotGroupEditor {
  const t = useMobileTranslation()
  const { client, hostId, router, hostCapabilities } = controller
  const supported = hostCapabilities?.includes(BOTS_GROUPS_RUNTIME_CAPABILITY) === true
  const [newBot, setNewBot] = useState<{ open: () => void; botCount: number } | null>(null)
  const [reordering, setReordering] = useState(false)
  // Groups are the paired computer's, and Manual is its sort: a drag orders its bots and groups.
  const local = controller.bots.find(
    (listing): listing is ListedHostBots =>
      listing.kind === 'listed' && listing.hostId === LOCAL_EXECUTION_HOST_ID
  )
  // Unread groups (a failed read) would leave their places out of the order, so wait for them.
  const canReorder =
    local?.view.sortBy === 'manual' &&
    local.groups !== undefined &&
    local.bots.length + local.groups.length > 1
  const [actions, setActions] = useState<BotGroup | null>(null)
  const [editing, setEditing] = useState<BotGroup | 'new' | null>(null)
  // The members sheet picks from the host's full bots, read only when it opens.
  const [bots, setBots] = useState<PhoneBot[]>([])
  const open = (group: Pick<BotGroup, 'id'>) =>
    router.push(`/h/${encodeURIComponent(hostId ?? '')}/group/${encodeURIComponent(group.id)}`)
  const edit = (group: BotGroup | 'new') => {
    if (!client || !hostId) {
      return
    }
    void readHostBots(client, hostBotsKey(hostId)).then((read) => {
      if (read.kind === 'bots') {
        setBots(read.bots)
        setEditing(group)
      }
    })
  }
  const changed = controller.newBot.created
  const sheets = (
    <>
      <ActionSheetModal
        visible={newBot !== null}
        onClose={() => setNewBot(null)}
        actions={botCreateMenuActions({
          t,
          botCount: newBot?.botCount ?? 0,
          hostLabel: controller.state.hostName,
          onNewBot: () => newBot?.open(),
          onNewGroup: () => edit('new'),
          onReorder: canReorder ? () => setReordering(true) : null
        })}
      />
      <MobileBotsReorderSheet
        // Leaving Manual on the computer ends the drag, as the desktop drags only in Manual.
        visible={reordering && canReorder}
        onClose={() => setReordering(false)}
        client={client}
        listing={local ?? null}
      />
      <ActionSheetModal
        visible={actions !== null}
        title={actions?.name}
        onClose={() => setActions(null)}
        actions={botGroupMenuActions({
          t,
          onManageMembers: () => {
            if (actions) {
              edit(actions)
            }
          },
          onDelete:
            actions && client
              ? () =>
                  confirmMobileBotGroupDelete({
                    client,
                    group: actions,
                    t,
                    onDeleted: changed,
                    onError: (message) => Alert.alert(message)
                  })
              : null
        })}
      />
      {editing && client ? (
        <MobileBotGroupMembers
          key={editing === 'new' ? 'new' : `${editing.id}:${editing.revision}`}
          group={editing === 'new' ? undefined : editing}
          bots={bots}
          client={client}
          onClose={() => setEditing(null)}
          onSaved={(group) => {
            setEditing(null)
            changed()
            open(group)
          }}
        />
      ) : null}
    </>
  )
  return {
    supported,
    chooseNew: (next, botCount) => (supported ? setNewBot({ open: next, botCount }) : next()),
    showActions: setActions,
    open,
    sheets
  }
}
