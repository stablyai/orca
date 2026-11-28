import { useMemo } from 'react'
import { Text } from 'react-native'
import { FolderGit2 } from 'lucide-react-native'
import { NavBarBadge } from '../../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { formatTimeAgo } from '../../worktree/agent-lineage/agent-row-display'
import { useCachedHostWorktrees } from './use-cached-host-worktrees'
import { useRouter } from 'expo-router'
import { holdSessionLeave } from '../session-leave-guard'
import { otherWorkspaceRows } from './mobile-session-other-workspaces'
import {
  SIDEBAR_MARK_SIZE,
  SidebarLabel,
  SidebarRow,
  SidebarRowAsk,
  SidebarRowMark,
  SidebarRowText
} from './MobileSessionSidebarRow'

/** Three other workspaces at the sidebar's foot, a waiting one first; a tap lands on the waiting tab. */
export function MobileSessionOtherWorkspaces({
  hostId,
  worktreeId,
  now
}: {
  hostId: string
  worktreeId: string
  now: number
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const router = useRouter()
  const worktrees = useCachedHostWorktrees(hostId)
  // Ranked when the catalog changes, not every minute: the clock only moves the times on the rows.
  const rows = useMemo(
    () => otherWorkspaceRows(worktrees ?? [], worktreeId, now, t),
    [worktrees, worktreeId, t]
  )
  if (rows.length === 0) {
    return null
  }
  return (
    <>
      <SidebarLabel title={t('session.sidebar.otherWorkspaces', 'Other workspaces')} />
      {rows.map((row) => (
        <SidebarRow
          key={row.worktreeId}
          accessibilityLabel={[row.name, row.stateWord, row.ask].filter(Boolean).join(', ')}
          // Takes this session's place over the workspace list, as the list's own rows do, so Back
          // still goes there and the session being left unmounts (with its Back claim).
          onPress={() => {
            if (holdSessionLeave()) {
              return
            }
            const pane = row.paneKey ? `&paneKey=${encodeURIComponent(row.paneKey)}` : ''
            router.replace(
              `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(row.worktreeId)}?name=${encodeURIComponent(row.name)}${pane}`
            )
          }}
        >
          <SidebarRowMark
            state={undefined}
            mark={
              <FolderGit2
                size={SIDEBAR_MARK_SIZE - 2}
                color={colors.textSecondary}
                strokeWidth={2}
              />
            }
          />
          <SidebarRowText title={row.name} unread={row.needsYou > 0}>
            {row.needsYou > 0 ? (
              <SidebarRowAsk
                row={{ stateWord: row.stateWord, content: row.ask, dotState: undefined }}
              />
            ) : null}
          </SidebarRowText>
          {row.needsYou > 0 ? (
            <NavBarBadge
              count={row.needsYou}
              color={colors.agentQuestion}
              ringColor="transparent"
              style={styles.badge}
            />
          ) : row.activityAt !== null ? (
            <Text style={styles.time}>{formatTimeAgo(row.activityAt, now, t)}</Text>
          ) : null}
        </SidebarRow>
      ))}
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  // In the row's trailing slot, where the tab rows' × sits.
  badge: { position: 'relative', top: 0, right: 0, marginRight: spacing.md },
  time: {
    marginRight: spacing.md,
    fontSize: 12,
    color: colors.textMuted,
    fontVariant: ['tabular-nums']
  }
}))
