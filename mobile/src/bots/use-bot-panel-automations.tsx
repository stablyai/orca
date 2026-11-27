// The panel's Automations: the list with each row's menu, the editor page a row's Edit pushes, and
// the sheets both open, which the panel draws beside its drawer (a Chats row's Delete confirm too).
import { ScrollView, View } from 'react-native'
import { useAutomationSheet } from '../automations/AutomationSheets'
import { BotAutomationEditor } from '../automations/BotAutomationEditor'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { useHostBotsEntry } from './host-bot-store'
import { MobileBotAutomationsTab } from './MobileBotAutomationsTab'
import type { RouteBot } from './use-route-bot'

export function useBotPanelAutomations(
  props: {
    client: RpcClient | null
    routeBot: RouteBot
    hostKey: string
    online: boolean
    onNewAutomation: (() => void) | null
    onAskInChat: ((draft: string) => void) | null
    onViewRuns: ((automationId: string) => void) | null
  },
  pager: { open: (page: `automation:${string}`) => void; close: () => void },
  showToast: (message: string, durationMs?: number) => void
) {
  const styles = useThemedStyles(stylesSheet)
  const hostBots = useHostBotsEntry(props.hostKey)
  const { present, host: sheets } = useAutomationSheet()
  const { bot, activity } = props.routeBot
  const tab = activity ? (
    <MobileBotAutomationsTab
      client={props.client}
      bot={bot}
      rows={activity.automations ?? null}
      waits={activity.waits}
      showToast={showToast}
      onNewAutomation={props.onNewAutomation}
      actions={{
        onEdit: (id) => pager.open(`automation:${id}`),
        onAskInChat: props.onAskInChat,
        onViewRuns: props.onViewRuns,
        present
      }}
      online={props.online}
    />
  ) : null
  const page = (automationId: string) => (
    <View style={styles.page}>
      <ScrollView
        style={styles.page}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <BotAutomationEditor
          key={automationId}
          client={props.client}
          automationId={automationId}
          bots={hostBots?.bots ?? [bot]}
          threadReplies={hostBots?.threadReplies ?? false}
          online={props.online}
          onBack={pager.close}
          onSaved={() => {
            props.routeBot.refresh()
            pager.close()
          }}
          onAskInChat={props.onAskInChat}
          present={present}
        />
      </ScrollView>
    </View>
  )
  return { tab, page, sheets, present }
}

const stylesSheet = themedStyleSheet((colors) => ({
  page: { flex: 1, backgroundColor: colors.sheetSurface }
}))
