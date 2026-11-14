import { memo, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { ChevronUp, ListChecks } from 'lucide-react-native'
import {
  nativeChatCompletedTaskCount,
  nativeChatTaskLabel,
  type NativeChatTaskList
} from '../../../../../../src/shared/native-chat/input/task-lists/native-chat-task-list'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { toolStyles, toolType } from '../../transcript/tool-results/mobile-native-chat-tool-styles'
import { MobileNativeChatChecklist } from './MobileNativeChatTaskList'
import { nativeChatTaskListCopy } from './native-chat-task-list-copy'
import { trayStripStyles as strip } from './mobile-native-chat-tray-strip-styles'

const VISIBLE_ROWS = 6
const MAX_REMEMBERED = 64
// The strip remounts whenever the chat view does, so each conversation's choice lives here.
const openByConversation = new Map<string, boolean>()

function useConversationOpen(conversationKey: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => openByConversation.get(conversationKey) ?? false)
  const remember = (next: boolean): void => {
    openByConversation.delete(conversationKey)
    openByConversation.set(conversationKey, next)
    const oldest = openByConversation.keys().next().value
    if (openByConversation.size > MAX_REMEMBERED && oldest !== undefined) {
      openByConversation.delete(oldest)
    }
    setOpen(next)
  }
  return [open, remember]
}

function MobileNativeChatDockedTaskListImpl({
  list,
  conversationKey
}: {
  list: NativeChatTaskList
  conversationKey: string
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [open, setOpen] = useConversationOpen(conversationKey)
  const completed = nativeChatCompletedTaskCount(list)
  const copy = nativeChatTaskListCopy(t, { completed, total: list.tasks.length })
  const current = list.tasks.find((task) => task.status === 'in_progress')
  // Collapsed, the header names where the agent is; open, the checklist does.
  const lead = !open && current ? nativeChatTaskLabel(current) : copy.title
  return (
    <View style={strip.list} testID="docked-task-list">
      <View style={strip.box}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${lead}, ${copy.progress}`}
          hitSlop={spacing.xs}
          style={({ pressed }) => [strip.header, pressed && strip.pressed]}
          onPress={() => setOpen(!open)}
        >
          <ListChecks size={14} color={colors.textMuted} strokeWidth={2} />
          <Text style={styles.lead} numberOfLines={1} ellipsizeMode="tail">
            {lead}
          </Text>
          <Text style={styles.count}>{`${completed}/${list.tasks.length}`}</Text>
          <View style={open ? strip.caretOpen : undefined}>
            <ChevronUp size={14} color={colors.textMuted} strokeWidth={2} />
          </View>
        </Pressable>
        {open ? (
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            nestedScrollEnabled
          >
            <MobileNativeChatChecklist list={list} fontScale={1} />
            {list.explanation ? (
              <Text style={[toolStyles.lineMeta, toolType(1).meta, styles.explanation]}>
                {list.explanation}
              </Text>
            ) : null}
          </ScrollView>
        ) : null}
      </View>
    </View>
  )
}

export const MobileNativeChatDockedTaskList = memo(MobileNativeChatDockedTaskListImpl)

const styles = themedStyleSheet(() => ({
  lead: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '500'
  },
  count: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontVariant: ['tabular-nums']
  },
  body: {
    // About six checklist rows, then the list scrolls.
    maxHeight: VISIBLE_ROWS * (toolType(1).row.lineHeight + spacing.xs) + spacing.xs
  },
  bodyContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm
  },
  explanation: {
    paddingTop: spacing.xs
  }
}))
