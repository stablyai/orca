// An agent's automation opened from the Automations page: the agent's own editor, with the host's
// agents to pick from and its sheets drawn here, outside any drawer.
import { useEffect, useMemo, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { toAutomationOwnerPrecondition } from '../../../src/shared/automations/ownership/automation-owner-precondition'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useHostBotsEntry } from '../bots/host-bot-store'
import { hostBotsKey, readHostBots, type HostBotsRead } from '../bots/host-bots-read'
import { Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { AutomationButton } from './AutomationControls'
import { automationStyles as styles } from './automation-styles'
import type { MobileAutomationRow } from './automation-reply-schema'
import { useAutomationSheet } from './AutomationSheets'
import { BotAutomationEditor } from './BotAutomationEditor'
import type { AutomationLeaveSlot } from './AutomationEditorNavigation'

export function AutomationPageBotEditor(props: {
  row: MobileAutomationRow
  client: RpcClient | null
  hostId: string
  executionHost?: ExecutionHostId
  connected: boolean
  /** Back to the automation, which reads its newest record from the list. */
  onBack: (row: MobileAutomationRow) => void
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
  useEffect(() => {
    if (client) {
      void readHostBots(client, key).then((answer) => setRead(answer.kind))
    }
  }, [client, key, retry])
  const { present, host: sheets } = useAutomationSheet()
  const expectedOwner = useMemo(
    () => toAutomationOwnerPrecondition(row.item.selector),
    [row.item.selector]
  )
  if (!hostBots && read !== 'bots') {
    return read === null ? null : (
      <View style={styles.stack}>
        <Text accessibilityRole="alert" style={styles.error}>
          {read === 'no-capability'
            ? t(
                'automations.mobile.hostUnavailable',
                'Automations are unavailable on this host. Update Orca on that host and reconnect.'
              )
            : t(
                'automations.mobile.hostUnreachable',
                'Could not reach this host. Reconnect, then refresh to check its current state.'
              )}
        </Text>
        <AutomationButton
          label={t('automations.mobile.refresh', 'Refresh')}
          onPress={() => setRetry((value) => value + 1)}
        />
      </View>
    )
  }
  return (
    <>
      <BotAutomationEditor
        key={row.automation.id}
        client={props.client}
        automationId={row.automation.id}
        expectedOwner={expectedOwner}
        bots={hostBots?.bots ?? []}
        threadReplies={hostBots?.threadReplies ?? false}
        online={props.connected}
        onBack={() => props.onBack(row)}
        onSaved={(automation) => props.onSaved({ ...row, automation })}
        leaveGuard={props.leaveGuard}
        // Its events change in the agent's chat, which this page doesn't hold.
        onAskInChat={null}
        present={present}
      />
      {sheets}
    </>
  )
}
