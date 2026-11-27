import { useMemo, type ComponentType } from 'react'
import { Text, View } from 'react-native'
import { Folder, GitBranch, ListChecks } from 'lucide-react-native'
import { NavBarBadge } from '../../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { prStateIcon } from '../../source-control/review/status/pr-state-token'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { prStateColor } from '../../worktree/row-presentation/WorktreeMetaGlyphs'
import { UNCACHED_LINKED_PR_STATE } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import type { ActivePanel } from '../session-panel-host'
import type { MobileSessionController } from '../use-mobile-session-controller'
import { SIDEBAR_MARK_SIZE, SidebarRow } from './MobileSessionSidebarRow'
import { useCachedHostWorktrees } from './use-cached-host-worktrees'
import type { MobileSessionSidebar } from './use-mobile-session-sidebar'

type IconProps = { size?: number; color?: string; strokeWidth?: number }
type Place = {
  key: string
  label: string
  icon: ComponentType<IconProps>
  color?: string
  badge?: number
  current: boolean
  onPress: () => void
}

/** The workspace's places: a bot's Items, else Source control; then Files and Checks. */
export function MobileSessionSidebarPlaces({
  controller,
  sidebar
}: {
  controller: MobileSessionController
  sidebar: MobileSessionSidebar
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const {
    hostId,
    worktreeId,
    isFloatingWorkspaceRoute,
    itemsOnPhone,
    routeBot,
    botPanel,
    openBotPanel,
    showChecksAction,
    activePanel,
    handlePanelTap
  } = controller
  // The PR state from the host list's cached catalog, as the bar's source control button showed it.
  const worktrees = useCachedHostWorktrees(hostId)
  const pr = useMemo(
    () => worktrees?.find((row) => row.worktreeId === worktreeId)?.linkedPR ?? null,
    [worktrees, worktreeId]
  )
  const prState = pr && pr.state !== UNCACHED_LINKED_PR_STATE ? pr.state : null
  // Docked, the place opens beside the column; otherwise the session comes back first.
  const go = (open: () => void) => () => {
    if (!sidebar.docked) {
      sidebar.close()
    }
    open()
  }
  const panel = (key: Exclude<ActivePanel, null>, label: string, icon: Place['icon']) => ({
    key,
    label,
    icon,
    current: sidebar.docked && activePanel === key,
    onPress: go(() => handlePanelTap(key))
  })
  const places: Place[] = [
    // A bot's home isn't a repository: its Items take Source control's place.
    ...(itemsOnPhone && routeBot
      ? [
          {
            key: 'items',
            label: t('session.header.items', 'Items'),
            icon: ListChecks,
            badge: routeBot.needsYou,
            current: botPanel !== null,
            onPress: go(() => openBotPanel({ tab: 'items' }))
          }
        ]
      : !isFloatingWorkspaceRoute
        ? [
            {
              ...panel(
                'sourceControl',
                t('session.header.sourceControl', 'Source control'),
                pr ? prStateIcon(pr.state) : GitBranch
              ),
              color: prState ? prStateColor(prState, colors) : undefined
            }
          ]
        : []),
    ...(!isFloatingWorkspaceRoute
      ? [panel('files', t('session.sidebar.files', 'Files'), Folder)]
      : []),
    ...(showChecksAction
      ? [panel('pr', t('session.headerMoreActionsSheet.checks', 'Checks'), ListChecks)]
      : [])
  ]
  if (places.length === 0) {
    return null
  }
  return (
    <View style={styles.places}>
      {places.map((item) => (
        <SidebarRow
          key={item.key}
          accessibilityLabel={
            item.badge
              ? t('session.header.itemsNeedYou', 'Items, {{count}} need you', { count: item.badge })
              : item.label
          }
          current={item.current}
          onPress={item.onPress}
        >
          <View style={styles.icon}>
            <item.icon
              size={SIDEBAR_MARK_SIZE}
              color={item.color ?? colors.textPrimary}
              strokeWidth={1.75}
            />
          </View>
          <Text style={styles.label} numberOfLines={1}>
            {item.label}
          </Text>
          {item.badge ? (
            <NavBarBadge
              count={item.badge}
              color={colors.agentQuestion}
              ringColor="transparent"
              style={styles.badge}
            />
          ) : null}
        </SidebarRow>
      ))}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  places: { paddingTop: spacing.md },
  icon: { width: SIDEBAR_MARK_SIZE, alignItems: 'center' },
  label: { flex: 1, fontSize: 16, color: colors.textPrimary },
  // In the row's trailing slot, where the tab rows' × sits.
  badge: { position: 'relative', top: 0, right: 0, marginRight: spacing.md }
}))
