import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { themedStyleSheet } from '../theme/themed-styles'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderTree
} from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  isMultiRepoMemberRetryable,
  multiRepoChipText,
  multiRepoMemberStateLabel,
  multiRepoRowNeedsAttention,
  type MobileMultiRepoMember,
  type MobileMultiRepoSummary
} from '../worktree/multi-repo-workspace-summary'

type Props = {
  summary: MobileMultiRepoSummary
  retryingMemberIds: ReadonlySet<string>
  onOpenMember: (member: MobileMultiRepoMember) => void
  onRetryMember: (member: MobileMultiRepoMember) => void
}

export function MultiRepoMemberRows({
  summary,
  retryingMemberIds,
  onOpenMember,
  onRetryMember
}: Props) {
  const [expanded, setExpanded] = useState(() => multiRepoRowNeedsAttention(summary))
  const chip = multiRepoChipText(summary.members)
  return (
    <View>
      <Pressable
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${chip}, ${expanded ? 'collapse' : 'expand'} repos`}
        onPress={(event) => {
          event.stopPropagation()
          setExpanded((value) => !value)
        }}
      >
        {expanded ? (
          <ChevronDown size={12} color={colors.textSecondary} />
        ) : (
          <ChevronRight size={12} color={colors.textSecondary} />
        )}
        <FolderTree size={12} color={colors.textSecondary} />
        <Text style={styles.toggleText}>{chip}</Text>
      </Pressable>
      {expanded
        ? summary.members.map((member) => (
            <MemberRow
              key={member.memberId}
              member={member}
              retrying={retryingMemberIds.has(member.memberId)}
              onOpen={onOpenMember}
              onRetry={onRetryMember}
            />
          ))
        : null}
    </View>
  )
}

function MemberRow({
  member,
  retrying,
  onOpen,
  onRetry
}: {
  member: MobileMultiRepoMember
  retrying: boolean
  onOpen: (member: MobileMultiRepoMember) => void
  onRetry: (member: MobileMultiRepoMember) => void
}) {
  const busy = retrying || member.state === 'creating'
  const openable = member.state === 'ready' && Boolean(member.worktreeId)
  const detail =
    member.state === 'failed' || member.state === 'interrupted'
      ? member.failureMessage || multiRepoMemberStateLabel(member.state)
      : multiRepoMemberStateLabel(member.state)
  return (
    <View style={styles.memberRow}>
      <Pressable
        style={styles.memberMain}
        disabled={!openable}
        accessibilityRole="button"
        accessibilityLabel={`${member.dirName}, ${multiRepoMemberStateLabel(member.state)}`}
        onPress={(event) => {
          event.stopPropagation()
          onOpen(member)
        }}
      >
        <View style={styles.memberIcon}>
          {busy ? (
            <ActivityIndicator size="small" color={colors.textMuted} />
          ) : member.state === 'ready' ? (
            <Check size={12} color={colors.statusGreen} />
          ) : member.state === 'queued' ? (
            <Circle size={12} color={colors.textMuted} />
          ) : (
            <AlertTriangle size={12} color={colors.statusAmber} />
          )}
        </View>
        <View style={styles.memberText}>
          <Text style={styles.memberName} numberOfLines={1}>
            {member.dirName}
          </Text>
          <Text style={styles.memberDetail} numberOfLines={2}>
            {retrying ? 'Retrying' : detail}
          </Text>
        </View>
      </Pressable>
      {isMultiRepoMemberRetryable(member) ? (
        <Pressable
          style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
          disabled={retrying}
          accessibilityRole="button"
          accessibilityLabel={`Retry ${member.dirName}`}
          onPress={(event) => {
            event.stopPropagation()
            onRetry(member)
          }}
        >
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  toggle: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.xs,
    minHeight: 28,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 8,
    borderRadius: radii.button
  },
  toggleText: { fontSize: 11, color: colors.textSecondary, fontWeight: '600' },
  memberRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: spacing.sm },
  memberMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  memberIcon: { width: 16, alignItems: 'center' },
  memberText: { flex: 1 },
  memberName: { fontSize: 13, color: colors.textPrimary, fontWeight: '600' },
  memberDetail: { fontSize: typography.metaSize, color: colors.textMuted },
  retryButton: {
    minHeight: 44,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm
  },
  retryText: { fontSize: 13, color: colors.textPrimary, fontWeight: '600' },
  pressed: { opacity: 0.7 }
}))
