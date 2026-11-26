import { useRef } from 'react'
import { Text, View } from 'react-native'
import { ArrowUpRight, Ellipsis } from 'lucide-react-native'
import type { RuntimeWorktreeAgentRow } from '../../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { formatAgentTypeLabel } from '../../../../../src/shared/agent-status/presentation/agent-type-label'
import { withoutNativeChatVisualDirectiveLines } from '../../../../../src/shared/native-chat/visuals/native-chat-visual-directive'
import { AgentStateDot } from '../../../agents/presentation/AgentStateDot'
import { BottomDrawer } from '../../../components/bottom-drawer/BottomDrawer'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import {
  LIST_LEADING_INSET,
  LIST_ROW_PADDING,
  ListGroup,
  ListRow
} from '../../../components/list/ListGroup'
import {
  ActionSheetContent,
  type ActionSheetAction
} from '../../../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, spacing } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { agentDotState, agentRowTimeAt, agentStateLabel, formatTimeAgo } from '../agent-row-display'
import { agentTileTitle } from '../agent-tile-title'
import type { NestedAgent } from './WorktreeAgentCarousel'

type Props = {
  /** The agent whose details are shown; null keeps the sheet closed. */
  agent: RuntimeWorktreeAgentRow | null
  /** The agent's sub-agents and spawned agents; each row opens its pane. */
  nested: readonly NestedAgent[]
  now: number
  onClose: () => void
  onOpenAgent?: (paneKey: string) => void
  onWorkspaceActions?: () => void
}

// Long-press details for a carousel tile: the full name a 2-line tile cannot fit, plus its actions.
export function WorktreeAgentDetailsSheet({
  agent,
  nested,
  now,
  onClose,
  onOpenAgent,
  onWorkspaceActions
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Why: the workspace actions sheet is another native modal; iOS presents it only after this one unmounts.
  const pendingActionRef = useRef<(() => void) | null>(null)
  const lastAgentRef = useRef<RuntimeWorktreeAgentRow | null>(null)
  if (agent) {
    lastAgentRef.current = agent
  }
  // Keep drawing the last agent while the sheet slides away.
  const shown = agent ?? lastAgentRef.current
  if (!shown) {
    return null
  }
  const title = agentTileTitle(shown, now)
  const reply = shown.lastAssistantMessage
    ? withoutNativeChatVisualDirectiveLines(shown.lastAssistantMessage).trim()
    : ''
  const dotState = agentDotState(shown, now)
  const updated = formatTimeAgo(agentRowTimeAt(shown), now)
  const actions: ActionSheetAction[] = [
    ...(onOpenAgent
      ? [
          {
            id: 'open',
            label: t('worktree.agentCarousel.openAgent', 'Open agent'),
            icon: ArrowUpRight,
            onPress: () => onOpenAgent(shown.paneKey)
          }
        ]
      : []),
    ...(onWorkspaceActions
      ? [
          {
            id: 'workspace-actions',
            label: t('worktree.agentCarousel.workspaceActions', 'Workspace actions'),
            icon: Ellipsis,
            onPress: () => {
              pendingActionRef.current = onWorkspaceActions
            }
          }
        ]
      : [])
  ]

  return (
    <BottomDrawer
      visible={agent !== null}
      onClose={onClose}
      onAfterClose={() => {
        const pending = pendingActionRef.current
        pendingActionRef.current = null
        pending?.()
      }}
      dragContentToDismiss
    >
      <ActionSheetContent
        headerIcon={
          shown.agentType ? <MobileAgentIcon agentId={shown.agentType} size={20} /> : undefined
        }
        title={formatAgentTypeLabel(shown.agentType)}
        message={updated ? `${agentStateLabel(dotState)} · ${updated}` : agentStateLabel(dotState)}
        actions={actions}
        onClose={onClose}
      >
        <View style={styles.body}>
          <Text style={styles.name} selectable>
            {title}
          </Text>
          {reply && reply !== title ? (
            <View style={styles.replyRow}>
              <AgentStateDot state={dotState} decorative />
              <Text style={styles.reply} numberOfLines={4}>
                {reply}
              </Text>
            </View>
          ) : null}
        </View>
        {nested.length > 0 ? (
          <>
            <Text style={styles.sectionLabel} accessibilityRole="header">
              {t('worktree.agentCarousel.subAgents', 'Sub-agents')}
            </Text>
            <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.nestedGroup}>
              {nested.map((child) => (
                <ListRow
                  key={child.key}
                  title={child.title}
                  titlePrefix={child.depth > 1 ? '↳ ' : undefined}
                  subtitle={child.detail}
                  leading={<AgentStateDot state={child.dotState} />}
                  navigates={Boolean(onOpenAgent)}
                  onPress={
                    onOpenAgent
                      ? () => {
                          onOpenAgent(child.openPaneKey)
                          onClose()
                        }
                      : undefined
                  }
                />
              ))}
            </ListGroup>
          </>
        ) : null}
      </ActionSheetContent>
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  body: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  name: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '600',
    color: colors.textPrimary
  },
  sectionLabel: {
    paddingHorizontal: LIST_ROW_PADDING,
    paddingBottom: spacing.xs,
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary
  },
  nestedGroup: { marginBottom: spacing.md },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs
  },
  reply: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary
  }
}))
