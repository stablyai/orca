import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { MobileNativeChatPermission } from '../session/native-chat/input/prompts/MobileNativeChatPermission'
import { MobileNativeChatQuestion } from '../session/native-chat/input/prompts/MobileNativeChatQuestion'
import type { BotGroup } from '../../../src/shared/bots/bot-group'
import type { PhoneBot } from './host-bots-operations'
import type { MobileBotGroupSession } from './MobileBotGroupTurns'
import { groupStyles as styles } from './mobile-bot-group-styles'

/** The room's waiting permission or question, one member's at a time, as the desktop's approval dock;
 *  "· N pending" opens the others. */
export function MobileBotGroupApprovalDock({
  group,
  bots,
  sessions
}: {
  group: BotGroup
  bots: readonly PhoneBot[]
  sessions: ReadonlyMap<string, MobileBotGroupSession>
}) {
  const t = useMobileTranslation()
  const [approvalBot, setApprovalBot] = useState<string | null>(null)
  const [listing, setListing] = useState(false)
  const waiting = group.members.filter((member) => {
    const session = sessions.get(member.sessionId)
    return session?.permission || session?.question
  })
  const requestMember = waiting.find((member) => member.botId === approvalBot) ?? waiting[0]
  const request = requestMember && sessions.get(requestMember.sessionId)
  if (!request || !requestMember) {
    return null
  }
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('bots.groups.pendingRequests', 'Pending requests')}
        onPress={() => setListing(true)}
      >
        <Text style={styles.notice}>
          {bots.find((bot) => bot.id === requestMember.botId)?.name}{' '}
          {t('bots.groups.needsYou', '· Needs you')}
          {waiting.length > 1
            ? t('bots.groups.valuePending', ' · {{value0}} pending', {
                value0: waiting.length
              })
            : ''}
        </Text>
      </Pressable>
      {request.permission ? (
        <MobileNativeChatPermission
          // One card per occurrence, as in the chat, so an accepted answer's hold ends with its prompt.
          key={`${requestMember.sessionId}:${JSON.stringify({ ...request.permission, options: undefined })}`}
          permission={request.permission}
          onRespond={request.respondPermission}
          onCancel={request.cancelPrompt}
        />
      ) : request.question ? (
        <MobileNativeChatQuestion
          // Another member's question starts with its own answers, not the last one's.
          key={requestMember.sessionId}
          question={request.question}
          onAnswer={request.respondQuestion}
          onCancel={request.cancelPrompt}
        />
      ) : null}
      <ActionSheetModal
        visible={listing}
        title={t('bots.groups.pendingRequests', 'Pending requests')}
        actions={waiting.map((member) => ({
          label: bots.find((bot) => bot.id === member.botId)?.name ?? 'Bot',
          onPress: () => setApprovalBot(member.botId)
        }))}
        onClose={() => setListing(false)}
      />
    </View>
  )
}
