import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewInstance
} from 'react-native'
import { ChevronLeft } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { AgentType } from '../../../../../src/shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { normalizeSubagentState } from '../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-summary'
import {
  formatSubagentTokens,
  subagentStateLabel
} from '../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
import { useBackClaim } from '../../../navigation/use-back-claim'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, pressedStyle, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileNativeChatMessage } from '../transcript/messages/MobileNativeChatMessage'
import { SubagentElapsed, subagentStateDotStyle } from './MobileNativeChatSubagentStatus'
import { sayMobileNativeChatSubagentGroup as say } from '../transcript/messages/native-chat-subagent-group-copy'
import { Prose } from '../transcript/message-content/MobileNativeChatProse'
import {
  nativeChatFontScale,
  useNativeChatTextSettings
} from '../preferences/native-chat-text-settings'
import {
  mobileNativeChatSubagentEntry,
  mobileNativeChatSubagentView,
  type MobileNativeChatSubagentSource
} from './mobile-native-chat-subagent-view'

const NO_STACK: readonly string[] = []
// Keep up with new rows only while the reader is this close to the end.
const FOLLOW_SLACK = 48

type Scope = {
  messages: readonly NativeChatMessage[]
  folded: readonly NativeChatMessage[]
  agent: AgentType
  source: MobileNativeChatSubagentSource | undefined
}

/** The subagents a reader opened from a chat, newest on top; Back pops one level. */
export function useMobileNativeChatSubagents({
  scopeKey,
  ...scope
}: Scope & {
  /** The chat shown; another chat starts at its main agent. */
  scopeKey: string
}): {
  open: (agentId: string) => void
  /** Drawn over the chat, which stays mounted so Back finds it where the reader left it. */
  screen: React.JSX.Element | null
} {
  const t = useMobileTranslation()
  const [opened, setOpened] = useState({ scopeKey, stack: NO_STACK })
  const stack = opened.scopeKey === scopeKey ? opened.stack : NO_STACK
  const open = useCallback(
    (agentId: string) => {
      // The strip sits above the composer, whose keyboard would cover the view.
      Keyboard.dismiss()
      setOpened((held) => {
        const shown = held.scopeKey === scopeKey ? held.stack : NO_STACK
        return shown.at(-1) === agentId ? held : { scopeKey, stack: [...shown, agentId] }
      })
    },
    [scopeKey]
  )
  const back = useCallback(
    () => setOpened((held) => ({ scopeKey, stack: held.stack.slice(0, -1) })),
    [scopeKey]
  )
  const agentId = stack.at(-1)
  const parentId = stack.at(-2)
  if (agentId === undefined) {
    return { open, screen: null }
  }
  const backLabel =
    parentId === undefined
      ? t('chat.subagentView.mainAgent', 'Main agent')
      : (mobileNativeChatSubagentEntry(parentId, scope.folded, scope.messages, scope.source?.roster)
          ?.label ?? t('chat.subagentView.unnamed', 'Subagent'))
  return {
    open,
    screen: <SubagentScreen key={agentId} {...scope} {...{ agentId, backLabel }} onBack={back} />
  }
}

/** One subagent's prompt, steps and reply, live while it works. */
function SubagentScreen({
  agentId,
  backLabel,
  onBack,
  messages,
  folded,
  agent,
  source
}: Scope & { agentId: string; backLabel: string; onBack: () => void }): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const fontScale = nativeChatFontScale(useNativeChatTextSettings().size)
  useBackClaim(() => {
    onBack()
    return true
  })
  const journalItems = source?.journalItems
  const roster = source?.roster
  const { entry, prompt, rows } = useMemo(
    () =>
      mobileNativeChatSubagentView({
        agentId,
        messages,
        folded,
        agent,
        source: journalItems ? { journalItems, roster } : undefined
      }),
    // `t` changes with the language its ending notice is written in.
    [agentId, messages, folded, agent, journalItems, roster, t]
  )
  const state = normalizeSubagentState(entry?.state ?? 'working')
  const working = state === 'working'
  const scroll = useRef<ScrollViewInstance>(null)
  // Opens at the newest row, like the chat, and keeps up while the reader stays there.
  const following = useRef(true)
  return (
    <View testID="subagent-view" style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('chat.subagentView.backTo', 'Back to {{value0}}', {
            value0: backLabel
          })}
          hitSlop={spacing.sm}
          style={({ pressed }) => [styles.back, pressed && pressedStyle]}
          onPress={onBack}
        >
          <ChevronLeft size={18} color={colors.textSecondary} strokeWidth={2} />
          <Text style={styles.backText} numberOfLines={1}>
            {backLabel}
          </Text>
        </Pressable>
        <View style={styles.titleRow}>
          <View style={[styles.dot, subagentStateDotStyle(state)]} />
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {entry?.label ?? t('chat.subagentView.unnamed', 'Subagent')}
          </Text>
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {subagentStateLabel(state, 1, 1, say)}
          {entry?.startedAt !== undefined ? (
            <>
              {' · '}
              <SubagentElapsed
                startedAt={entry.startedAt}
                settledAt={entry.settledAt ?? null}
                counting={working}
              />
            </>
          ) : null}
          {typeof entry?.tokens === 'number'
            ? ` · ${say('tokens', { value0: formatSubagentTokens(entry.tokens) })}`
            : null}
        </Text>
      </View>
      <ScrollView
        ref={scroll}
        style={styles.body}
        contentContainerStyle={{
          paddingTop: spacing.sm,
          paddingBottom: spacing.lg + insets.bottom
        }}
        scrollEventThrottle={32}
        onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          following.current =
            contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK
        }}
        onContentSizeChange={() => {
          if (following.current) {
            scroll.current?.scrollToEnd({ animated: false })
          }
        }}
      >
        {prompt ? (
          <View style={styles.prompt}>
            <Text style={styles.promptLabel}>
              {t('chat.subagentView.promptFromMain', 'Prompt from main agent')}
            </Text>
            <Prose
              block={{ type: 'text', text: prompt }}
              text={prompt}
              fontScale={fontScale}
              userMessage
            />
          </View>
        ) : null}
        {rows.map((message, index) => (
          <MobileNativeChatMessage
            key={message.id}
            message={message}
            fontScale={fontScale}
            structuredActivityUi={source !== undefined}
            activeTurnIsWorking={working}
            mayStillGrow={working && index === rows.length - 1}
          />
        ))}
      </ScrollView>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.bgBase
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  back: {
    minHeight: 44,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginLeft: -spacing.xs
  },
  backText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill
  },
  title: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  // Aligns under the title, past the 6pt dot and its gap.
  meta: {
    paddingLeft: 6 + spacing.sm,
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  body: {
    flex: 1
  },
  // Rows pad themselves; the prompt card lines up with them.
  prompt: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    backgroundColor: colors.chatUserSurface,
    borderWidth: 1,
    borderColor: colors.chatUserBorder,
    borderRadius: radii.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  promptLabel: {
    marginBottom: spacing.xs,
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
}))
