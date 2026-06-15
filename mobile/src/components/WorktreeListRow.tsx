import { Bell, GitPullRequest } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { triggerMediumImpact } from '../platform/haptics'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { AgentSpinner } from './AgentSpinner'
import { MobileRepoIcon } from './MobileRepoIcon'
import { WorktreeAgentList } from './WorktreeAgentList'
import { WorktreeMetaGlyphs, prStateColor } from './WorktreeMetaGlyphs'

// Minimal row shape needed for rendering — a structural subset of the screen's
// Worktree so this component stays decoupled from the screen's local type.
export type WorktreeListRowItem = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  preview: string
  unread: boolean
  isActive?: boolean
  linkedPR: { number: number; state: string } | null
  linkedIssue?: number | null
  linkedLinearIssue?: string | null
  linkedGitLabMR?: number | null
  linkedGitLabIssue?: number | null
  comment?: string
  agents?: RuntimeWorktreeAgentRow[]
}

type WorktreeRollupStatus = 'working' | 'active' | 'permission' | 'done' | 'inactive'

type Props<T extends WorktreeListRowItem> = {
  item: T
  isReadOnly: boolean
  now: number
  repoColor: string
  repoIcon?: RepoIcon | null
  status: WorktreeRollupStatus
  onPress: (item: T) => void
  onLongPress: (item: T) => void
}

export function WorktreeListRow<T extends WorktreeListRowItem>({
  item,
  isReadOnly,
  now,
  repoColor,
  repoIcon,
  status,
  onPress,
  onLongPress
}: Props<T>) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.worktreeRow,
        item.isActive && styles.worktreeRowActive,
        pressed && styles.worktreeRowPressed
      ]}
      disabled={isReadOnly}
      onPress={() => onPress(item)}
      onLongPress={() => {
        triggerMediumImpact()
        onLongPress(item)
      }}
      delayLongPress={400}
    >
      <View style={styles.indicatorCol}>
        <AgentSpinner status={status} />
        {item.unread && (
          <Bell
            size={10}
            color={colors.statusAmber}
            fill={colors.statusAmber}
            style={styles.unreadBell}
          />
        )}
      </View>

      <View style={styles.worktreeMain}>
        <View style={styles.worktreeNameRow}>
          <Text
            style={[
              styles.worktreeName,
              item.unread && styles.worktreeNameUnread,
              isReadOnly && styles.textReadOnly
            ]}
            numberOfLines={1}
          >
            {item.displayName || item.repo}
          </Text>
          {item.linkedPR && (
            <View style={styles.prBadge}>
              <GitPullRequest size={10} color={prStateColor(item.linkedPR.state)} />
              <Text style={[styles.prNumber, { color: prStateColor(item.linkedPR.state) }]}>
                #{item.linkedPR.number}
              </Text>
            </View>
          )}
          <WorktreeMetaGlyphs
            comment={item.comment}
            linkedLinearIssue={item.linkedLinearIssue}
            linkedGitLabMR={item.linkedGitLabMR}
            linkedIssue={item.linkedIssue}
            linkedGitLabIssue={item.linkedGitLabIssue}
          />
        </View>
        <View style={styles.worktreeMetaRow}>
          {repoIcon ? (
            <MobileRepoIcon repoIcon={repoIcon} size={11} color={colors.textSecondary} />
          ) : (
            <View style={[styles.repoDot, { backgroundColor: repoColor }]} />
          )}
          <Text style={styles.repoName} numberOfLines={1}>
            {item.repo}
          </Text>
          <Text style={styles.branchName} numberOfLines={1}>
            {item.branch}
          </Text>
        </View>
        {item.agents && item.agents.length > 0 ? (
          <WorktreeAgentList agents={item.agents} now={now} unvisited={item.unread} />
        ) : item.preview ? (
          <Text style={styles.worktreePreview} numberOfLines={1}>
            {item.preview}
          </Text>
        ) : null}
      </View>

      {item.liveTerminalCount > 0 && (
        <Text style={styles.terminalCount}>{item.liveTerminalCount}</Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    // Reserve the active accent bar width so active/inactive rows align.
    borderLeftWidth: 2,
    borderLeftColor: 'transparent'
  },
  worktreeRowPressed: {
    backgroundColor: colors.bgRaised
  },
  // Highlight the worktree currently focused on the desktop, mirroring the
  // desktop sidebar's selected-card treatment (raised fill + left accent).
  worktreeRowActive: {
    backgroundColor: colors.bgPanel,
    borderLeftColor: colors.accentBlue
  },
  indicatorCol: {
    width: 20,
    alignItems: 'center',
    paddingTop: 6,
    marginRight: spacing.sm,
    gap: 4
  },
  unreadBell: {
    marginTop: 2
  },
  worktreeMain: {
    flex: 1,
    marginRight: spacing.sm
  },
  worktreeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  worktreeName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 1
  },
  worktreeNameUnread: {
    fontWeight: '700'
  },
  textReadOnly: {
    opacity: 0.5
  },
  prBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  prNumber: {
    fontSize: 10,
    color: colors.textSecondary
  },
  worktreeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: spacing.xs
  },
  repoDot: {
    width: 6,
    height: 6,
    borderRadius: 3
  },
  repoName: {
    fontSize: 11,
    color: colors.textSecondary,
    maxWidth: 100
  },
  branchName: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    flexShrink: 1
  },
  worktreePreview: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    marginTop: 2
  },
  terminalCount: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    minWidth: 16,
    textAlign: 'right',
    paddingTop: 3
  }
})
