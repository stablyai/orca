// An agent's automation opened from the Automations page: the agent's own editor in the page's
// editor sheet, with the host's agents to pick from.
import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { toAutomationOwnerPrecondition } from '../../../src/shared/automations/ownership/automation-owner-precondition'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useHostBotsEntry } from '../bots/host-bot-store'
import { hostBotsKey, readHostBots, type HostBotsRead } from '../bots/host-bots-read'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SettingsNote } from '../settings/settings-screen-frame'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileAutomationRow } from './automation-reply-schema'
import type { PresentAutomationSheet } from './AutomationSheets'
import { BotAutomationEditor } from './BotAutomationEditor'
import type { AutomationLeaveSlot } from './AutomationEditorNavigation'

export function AutomationPageBotEditor(props: {
  visible: boolean
  row: MobileAutomationRow
  client: RpcClient | null
  hostId: string
  executionHost?: ExecutionHostId
  connected: boolean
  present: PresentAutomationSheet
  onClose: () => void
  onAfterClose: () => void
  onSaved: (row: MobileAutomationRow) => void
  leaveGuard?: AutomationLeaveSlot
}) {
  const t = useMobileTranslation()
  const { row, client } = props
  const key = hostBotsKey(props.hostId, props.executionHost)
  const hostBots = useHostBotsEntry(key)
  // This page may open before anything read the host's agents; an unread list never means deleted.
  const [read, setRead] = useState<HostBotsRead['kind'] | null>(null)
  const [retry, setRetry] = useState(0)
  const [changed, setChanged] = useState(false)
  useEffect(() => {
    if (client) {
      void readHostBots(client, key).then((answer) => setRead(answer.kind))
    }
  }, [client, key, retry])
  const expectedOwner = useMemo(
    () => toAutomationOwnerPrecondition(row.item.selector),
    [row.item.selector]
  )
  const unread = !hostBots && read !== 'bots'
  return (
    <BottomDrawer
      visible={props.visible}
      // Its edits live only in this sheet, so it stays up while they or a save are pending.
      dismissible={!changed}
      onClose={props.onClose}
      onAfterClose={props.onAfterClose}
    >
      {unread ? (
        <View>
          <SheetHeader
            title={t('automations.mobile.editAutomation', 'Edit automation')}
            leading={{ label: t('automations.mobile.cancel', 'Cancel'), onPress: props.onClose }}
          />
          {read === null ? null : (
            <>
              <SettingsNote error>
                {read === 'no-capability'
                  ? t(
                      'automations.mobile.hostUnavailable',
                      'Automations are unavailable on this host. Update Orca on that host and reconnect.'
                    )
                  : t(
                      'automations.mobile.hostUnreachable',
                      'Could not reach this host. Reconnect, then refresh to check its current state.'
                    )}
              </SettingsNote>
              <ListGroup>
                <ListRow
                  title={t('automations.mobile.refresh', 'Refresh')}
                  accent
                  onPress={() => setRetry((value) => value + 1)}
                />
              </ListGroup>
            </>
          )}
        </View>
      ) : (
        <BotAutomationEditor
          key={row.automation.id}
          client={props.client}
          automationId={row.automation.id}
          expectedOwner={expectedOwner}
          bots={hostBots?.bots ?? []}
          threadReplies={hostBots?.threadReplies ?? false}
          online={props.connected}
          onBack={props.onClose}
          onSaved={(automation) => props.onSaved({ ...row, automation })}
          leaveGuard={props.leaveGuard}
          // Its events change in the agent's chat, which this page doesn't hold.
          onAskInChat={null}
          present={props.present}
          sheet={{ onChanged: setChanged }}
        />
      )}
    </BottomDrawer>
  )
}
