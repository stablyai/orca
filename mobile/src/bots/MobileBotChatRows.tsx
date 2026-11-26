// The Bots list's tree rows under a bot, as the desktop sidebar draws them: a chat (its icon badged with its state,
// title, time or live counts, fold chevron), its workers as one line each, and their paging.
import { memo } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight } from 'lucide-react-native'
import { pressFoldableRow } from '../../../src/shared/bots/bot-row-press'
import {
  BOT_WORKSPACE_LINE_LOGO,
  botWorkspaceLineAgent
} from '../../../src/shared/bots/bot-sidebar-workspaces'
import { chatFoldSummary } from '../../../src/shared/bots/bot-chat-tree'
import { botSidebarWorkerPagingLabel } from '../../../src/shared/bots/bot-sidebar-tree'
import { structuredAgentSessionStatusPaneKey } from '../../../src/shared/agent-session/view/structured-agent-session-tab'
import type { WorktreeStatus } from '../../../src/shared/worktree/row-display/worktree-status-rollup'
import { AgentSpinner } from '../agents/presentation/AgentSpinner'
import { BotLineAgentLogos } from '../worktree/row-presentation/BotLineAgentLogos'
import { BotLineAgentMore } from '../worktree/row-presentation/BotLineAgentMore'
import { HostContextPill } from '../worktree/row-presentation/HostContextPill'
import { useNow } from '../hooks/use-now'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerMediumImpact } from '../platform/haptics/haptics'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { agentDotState, formatTimeAgo } from '../worktree/agent-lineage/agent-row-display'
import { areStructurallyEqual } from '../worktree/catalog/structural-equality'
import type { Worktree, WorktreeRowView } from '../worktree/workspace-list/workspace-list-types'
import { setBotChatFold } from './bot-chat-fold-store'
import { setBotChatSteps } from './bot-chat-steps-store'
import type {
  MobileBotChatLineFacts,
  MobileBotChatPagingFacts,
  MobileBotChatRowFacts
} from './host-bot-row-facts'
import { ChatBadgedIcon, useMobileBotChatLabel } from './MobileBotChatLeading'
import { MobileBotTextButton } from './MobileBotTextButton'

// The chat's icon sits centred under the bot's 32 pt avatar and its title starts where the bot's
// does; a worker's status under the chat's title, each child one step further in.
const AVATAR = 32
const LINE_INDENT = spacing.lg + AVATAR + spacing.md
const DEPTH_STEP = 24
// Grows the chevron's 20 pt column to a 44 pt target.
const CHEVRON_HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 } as const

function ChatRowComponent({
  home,
  facts,
  dimmed,
  isReadOnly,
  onOpen
}: {
  home: Worktree
  facts: MobileBotChatRowFacts
  dimmed: boolean
  isReadOnly: boolean
  /** Opens the bot's home with this chat's tab in front. */
  onOpen: (home: Worktree, paneKey: string) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { chat, foldable, open, trailing } = facts
  const now = useNow(30_000, trailing?.kind === 'time')
  const title = chat.origin === 'home' ? t('bots.chats.home', 'Home Chat') : chat.title
  const label = useMobileBotChatLabel(chat, title)
  const text =
    trailing?.kind === 'summary'
      ? chatFoldSummary(t, trailing.counts)
      : trailing?.kind === 'time'
        ? formatTimeAgo(trailing.at, now)
        : null
  const toggle = foldable
    ? () => setBotChatFold(facts.hostKey, facts.botId, chat.chatId, open ? 'folded' : 'open')
    : null
  // The phone's chat covers the list, so no row is ever the open one here: a tap only opens, and
  // folds are the chevron's alone.
  const press = () =>
    pressFoldableRow(
      {
        active: false,
        folded: foldable && !open,
        open: () => onOpen(home, structuredAgentSessionStatusPaneKey(chat.chatId)),
        toggle: null
      },
      { detail: 1 }
    )
  return (
    <Pressable
      style={({ pressed }) => [styles.chatRow, dimmed && styles.dimmed, pressed && styles.pressed]}
      disabled={isReadOnly}
      onPress={press}
      accessibilityRole="button"
      accessibilityLabel={[label, text].filter(Boolean).join(', ')}
      accessibilityState={foldable ? { expanded: open } : undefined}
    >
      <View style={styles.chatSlot}>
        <ChatBadgedIcon chat={chat} />
      </View>
      <Text style={[styles.chatTitle, chat.unread && styles.unread]} numberOfLines={1}>
        {title}
      </Text>
      {text ? (
        <Text style={styles.trailing} numberOfLines={1}>
          {text}
        </Text>
      ) : null}
      {toggle ? (
        <View style={styles.chevron}>
          <Pressable
            hitSlop={CHEVRON_HIT_SLOP}
            disabled={isReadOnly}
            onPress={(event) => {
              event.stopPropagation()
              toggle()
            }}
            accessibilityRole="button"
            accessibilityLabel={
              open
                ? t('bots.chats.fold', 'Fold {{name}}', { name: title })
                : t('bots.chats.unfold', 'Unfold {{name}}', { name: title })
            }
          >
            {open ? (
              <ChevronDown size={14} color={colors.textMuted} />
            ) : (
              <ChevronRight size={14} color={colors.textMuted} />
            )}
          </Pressable>
        </View>
      ) : null}
    </Pressable>
  )
}

export const MobileBotChatRow = memo(ChatRowComponent, areStructurallyEqual)

function PagingRowComponent({
  facts,
  dimmed
}: {
  facts: MobileBotChatPagingFacts
  dimmed: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { paging, steps, stepsKey } = facts
  return (
    <View style={[styles.paging, dimmed && styles.dimmed]}>
      {paging ? (
        <MobileBotTextButton
          label={botSidebarWorkerPagingLabel(t, paging)}
          onPress={() => setBotChatSteps(stepsKey, steps + 1)}
        />
      ) : null}
      {paging && steps > 0 ? <Text style={styles.pagingDot}>·</Text> : null}
      {steps > 0 ? (
        <MobileBotTextButton
          label={t('bots.chats.showFewer', 'Show fewer')}
          onPress={() => setBotChatSteps(stepsKey, 0)}
        />
      ) : null}
    </View>
  )
}

export const MobileBotChatPaging = memo(PagingRowComponent, areStructurallyEqual)

function LineNote({ note }: { note: MobileBotChatLineFacts['note'] }) {
  const t = useMobileTranslation()
  if (!note) {
    return null
  }
  const text =
    note === 'handed-over'
      ? t('bots.chats.handedOverInline', 'handed over')
      : t('bots.chats.fromClosedChatInline', 'from closed chat')
  return <Text style={styles.note}>{` · ${text}`}</Text>
}

function WorkerLineComponent({
  item,
  view,
  facts,
  status,
  isReadOnly,
  onPress,
  onLongPress
}: {
  item: Worktree
  view: WorktreeRowView
  facts: MobileBotChatLineFacts
  status: WorktreeStatus | null
  isReadOnly: boolean
  onPress: (item: Worktree) => void
  onLongPress?: (item: Worktree) => void
}) {
  useMobileColorScheme()
  const now = useNow(30_000, true)
  // One logo says who works there, as on the desktop's compact line.
  const agent = botWorkspaceLineAgent(
    (item.agents ?? []).map((row) => ({
      agentType: row.agentType,
      subagent: false,
      state: agentDotState(row, now)
    }))
  )
  return (
    <Pressable
      style={({ pressed }) => [
        styles.line,
        { paddingLeft: LINE_INDENT + (facts.depth - 1) * DEPTH_STEP },
        item.isActive && styles.active,
        view.dimmed && styles.dimmed,
        pressed && styles.pressed
      ]}
      disabled={isReadOnly}
      onPress={() => onPress(item)}
      onLongPress={
        onLongPress
          ? () => {
              triggerMediumImpact()
              onLongPress(item)
            }
          : undefined
      }
      delayLongPress={400}
    >
      <View style={styles.slot}>
        <AgentSpinner status={status ?? 'inactive'} workingMode={item.workingMode} />
      </View>
      {agent ? (
        <BotLineAgentLogos
          agent={agent}
          ringColor={item.isActive ? colors.bgPanel : colors.bgBase}
        />
      ) : (
        // Keeps the name in line with its siblings' when nobody works there.
        <View style={styles.noLogo} />
      )}
      {agent && agent.others > 0 ? (
        <BotLineAgentMore others={agent.others} needsYou={agent.othersNeedYou} />
      ) : null}
      <Text style={[styles.lineName, item.unread && styles.unread]} numberOfLines={1}>
        {item.displayName || item.repo}
        <LineNote note={facts.note} />
      </Text>
      {view.hostContextLabel ? (
        <View style={styles.pill}>
          <HostContextPill
            hostId={view.hostContextHostId ?? item.hostId}
            label={view.hostContextLabel}
            healthLabel={view.hostContextHealthLabel}
          />
        </View>
      ) : null}
    </Pressable>
  )
}

export const MobileBotWorkerLine = memo(WorkerLineComponent, areStructurallyEqual)

const styles = themedStyleSheet(() => ({
  // The bot row's grid: its padding, the avatar's column and its gap.
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    paddingHorizontal: spacing.lg
  },
  chatSlot: { width: AVATAR, alignItems: 'center', justifyContent: 'center' },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingRight: spacing.lg
  },
  slot: { width: 16, height: 16, alignItems: 'center', justifyContent: 'center' },
  chatTitle: { flex: 1, minWidth: 0, fontSize: 14, color: colors.textSecondary },
  lineName: { flex: 1, minWidth: 0, fontSize: 14, color: colors.textSecondary },
  unread: { fontWeight: '700', color: colors.textPrimary },
  note: { color: colors.textMuted, fontWeight: '400' },
  // The bot row's age type, so a list's times share one size and edge.
  trailing: { fontSize: 11, color: colors.textMuted, flexShrink: 0, maxWidth: '46%' },
  pagingDot: { fontSize: 13, color: colors.textMuted },
  chevron: { width: 20, alignItems: 'flex-end' },
  pill: { flexShrink: 0, maxWidth: '40%' },
  noLogo: { width: BOT_WORKSPACE_LINE_LOGO.size },
  paging: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
    paddingLeft: LINE_INDENT + DEPTH_STEP,
    paddingRight: spacing.lg
  },
  active: { backgroundColor: colors.bgPanel },
  dimmed: { opacity: 0.6 },
  pressed: { backgroundColor: colors.bgRaised }
}))
