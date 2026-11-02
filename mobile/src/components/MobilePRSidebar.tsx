import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, ScrollView, Text, View } from 'react-native'
import {
  ArrowRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  type LucideIcon
} from 'lucide-react-native'
import { MobileLoadErrorState, MobileStateView } from './MobileStateView'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { colors } from '../theme/mobile-theme'
import type { PrSidebarData } from '../session/mobile-pr-sidebar-state'
import { isPrSidebarDetailsPlaceholder } from '../session/mobile-pr-sidebar-state'
import { prSidebarRenderBranch } from './mobile-pr-sidebar-presentation'
import { ListGroup, ListRow, LIST_LEADING_INSET } from './list/ListGroup'
import { useNow } from '../hooks/use-now'
import { commentRelativeTime } from './pr-sidebar/pr-comment-relative-time'
import { prStateBadge } from './pr-sidebar/pr-checks-presentation'
import { statusColor } from './pr-sidebar/pr-sidebar-status-color'
import { PrTabEmptyState } from './pr-sidebar/PrTabEmptyState'
import { PrChangesCard, PrDescription } from './pr-sidebar/PrTabOverviewCards'
import { PrTabBottomAction } from './pr-sidebar/PrTabBottomAction'
import { MobilePrTabSheets } from './pr-sidebar/MobilePrTabSheets'
import { PrTabScreenView } from './pr-sidebar/PrTabScreenView'
import { buildPrGateRows, type PrGateRow, type PrGateTone } from './pr-sidebar/pr-tab-gates'
import {
  useMobilePrTab,
  type MobilePrCreateSettled,
  type MobilePrTab,
  type PrTabScreen
} from './pr-sidebar/use-mobile-pr-tab'
import { usePrTabMenuGroups } from './pr-sidebar/use-pr-tab-menu'
import { openMobilePrUrl } from './mobile-pr-url'
import { NavBarButton } from './nav-bar/NavBarButton'
import { PullDownMenu } from './nav-bar/PullDownMenu'
import { useBackClaim } from '../navigation/use-back-claim'
import { prTabStyles as styles } from './pr-sidebar/pr-tab-styles'

type BranchCompare = { commitsAhead?: number; baseRef: string } | null

type BodyProps = {
  tab: MobilePrTab
  onRetry: () => void
  bottomInset?: number
  /** Opens the Changes segment from the changes card; absent outside the hub. */
  onOpenChanges?: () => void
  branchCompare?: BranchCompare
  /** The dock's bottom action. The hub passes none: its next-step bar is the one bottom action there. */
  footer?: ReactNode
}

// The PR tab answers "can I merge, and what's blocking it": identity, gates, changes, description.
export function MobilePrTabBody({
  tab,
  onRetry,
  bottomInset = 0,
  onOpenChanges,
  branchCompare = null,
  footer = null
}: BodyProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { state, actions } = tab
  const branch = prSidebarRenderBranch(state)

  if (branch === 'loading') {
    return (
      <MobileStateView loading title={t('components.prSidebar.loading', 'Loading pull request…')} />
    )
  }
  if (branch === 'error') {
    return (
      <MobileLoadErrorState
        error={state.kind === 'error' ? state.message : null}
        onRetry={onRetry}
      />
    )
  }
  if (branch === 'blocked' || actions.blocked) {
    // Permanent R9 block has no retry styling; mutation-time blocked actions reach this state too.
    const message =
      actions.blocked ??
      (state.kind === 'blocked'
        ? state.message
        : t(
            'components.prSidebar.notPermitted',
            'Not permitted — your GitHub account is not connected.'
          ))
    return (
      <View style={styles.stateArea}>
        <Text style={styles.blockedText}>{message}</Text>
      </View>
    )
  }
  if (branch === 'none') {
    return (
      <View style={styles.container}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <PrTabEmptyState tab={tab} branchCompare={branchCompare} />
        </ScrollView>
        {footer}
      </View>
    )
  }
  if (branch !== 'ready' || state.kind !== 'ready') {
    return null
  }
  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, !footer && { paddingBottom: bottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        <PrTabSections tab={tab} data={state.data} onOpenChanges={onOpenChanges} />
      </ScrollView>
      {footer}
    </View>
  )
}

function PrTabSections({
  tab,
  data,
  onOpenChanges
}: {
  tab: MobilePrTab
  data: PrSidebarData
  onOpenChanges?: () => void
}) {
  useMobileColorScheme()
  const pr = data.pr
  const gates = useMemo(
    () =>
      buildPrGateRows({
        pr,
        details: data.details,
        checks: data.checks,
        checksError: data.checksError,
        botAuthorOverrides: tab.botAuthorOverrides
      }),
    [data.checks, data.checksError, data.details, pr, tab.botAuthorOverrides]
  )
  const openGate = (row: PrGateRow): (() => void) | undefined => {
    switch (row.target) {
      case 'checks':
        return tab.openChecksScreen
      case 'comments':
        return tab.openCommentsScreen
      case 'reviewers':
        return tab.openReviewersSheet
      case null:
        return undefined
    }
  }
  return (
    <>
      <PrTabHeader data={data} />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {gates.map((row) => {
          const onPress = openGate(row)
          return (
            <ListRow
              key={row.key}
              title={row.title}
              subtitle={row.subtitle ?? undefined}
              leading={<GateIcon row={row} />}
              navigates={onPress !== undefined}
              onPress={onPress}
            />
          )
        })}
      </ListGroup>
      <PrChangesCard data={data} onPress={onOpenChanges} />
      <PrDescription tab={tab} data={data} />
    </>
  )
}

function PrTabHeader({ data }: { data: PrSidebarData }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(60_000)
  const { pr, details } = data
  const item = details && !isPrSidebarDetailsPlaceholder(details) ? details.item : null
  const badge = prStateBadge(pr.state)
  const badgeColor = statusColor(badge.token)
  const author = item?.author ?? null
  const updatedAt = item?.updatedAt || pr.updatedAt
  const meta = [
    author,
    updatedAt
      ? t('pullRequest.tab.updated', 'updated {{time}}', {
          time: commentRelativeTime(updatedAt, now, t)
        })
      : null
  ]
    .filter(Boolean)
    .join(' · ')
  const headRef = item?.branchName ?? pr.headRefName ?? null
  const baseRef = item?.baseRefName ?? pr.baseRefName ?? null
  return (
    <View style={styles.header}>
      <View style={styles.metaRow}>
        <View style={[styles.badge, { borderColor: badgeColor }]}>
          <Text style={[styles.badgeText, { color: badgeColor }]}>{badge.label}</Text>
        </View>
        <Text style={styles.number}>#{pr.number}</Text>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {item?.title ?? pr.title}
      </Text>
      {headRef && baseRef ? (
        <View style={styles.refsRow}>
          <Text style={styles.ref} numberOfLines={1}>
            {headRef}
          </Text>
          <ArrowRight size={12} color={colors.textMuted} strokeWidth={2.2} />
          <Text style={styles.ref} numberOfLines={1}>
            {baseRef}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

const GATE_ICON: Record<Exclude<PrGateTone, 'loading'>, LucideIcon> = {
  passed: CircleCheck,
  blocking: CircleX,
  waiting: CircleDashed,
  idle: CircleMinus
}

function GateIcon({ row }: { row: PrGateRow }) {
  useMobileColorScheme()
  if (row.tone === 'loading') {
    return <ActivityIndicator size="small" color={colors.textSecondary} />
  }
  const Icon =
    row.tone === 'waiting' && row.key === 'threads'
      ? MessageCircle
      : row.tone === 'waiting' && row.key === 'checks'
        ? LoaderCircle
        : GATE_ICON[row.tone]
  const color =
    row.tone === 'passed'
      ? colors.statusGreen
      : row.tone === 'blocking'
        ? colors.statusRed
        : row.tone === 'waiting'
          ? colors.statusAmber
          : colors.textMuted
  return <Icon size={20} color={color} strokeWidth={2} />
}

type SidebarProps = Omit<Parameters<typeof useMobilePrTab>[0], 'onOpenScreen'> & {
  onRetry: () => void
  bottomInset?: number
}

/** The PR tab outside the Source Control hub (the diff review dock), with its own screens, menu and sheets. */
export function MobilePRSidebar({ onRetry, bottomInset = 0, ...input }: SidebarProps) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [screen, setScreen] = useState<PrTabScreen | null>(null)
  const { refetch } = input
  const onCreateSettled = useCallback(
    ({ created }: MobilePrCreateSettled) => {
      if (!created) {
        return
      }
      refetch({ includeDetails: true })
      // The dock has no Created notice, so "already open" or "created but not refreshed" opens the PR instead.
      if (created.warning) {
        openMobilePrUrl(created.url)
      }
    },
    [refetch]
  )
  const tab = useMobilePrTab({
    ...input,
    onOpenScreen: setScreen,
    onCreateSettled,
    live: screen === 'comments' ? 'details' : 'checks'
  })
  const refresh = () => refetch({ includeDetails: true })
  const prMenuGroups = usePrTabMenuGroups(tab, refresh)
  // Without a PR the dock still needs Refresh, e.g. after a PR is opened on the web.
  const menuGroups = prMenuGroups ?? [
    [
      {
        id: 'refresh',
        label: t('pullRequest.menu.refresh', 'Refresh'),
        closeBeforePress: true,
        onPress: refresh
      }
    ]
  ]
  const moreRef = useRef<View>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const close = () => setScreen(null)
  // The dock's drawer would otherwise take Back and close the whole PR panel from a pushed screen.
  useBackClaim(
    screen
      ? () => {
          setScreen(null)
          return true
        }
      : null
  )
  return (
    <View style={styles.container}>
      {screen ? (
        <PrTabScreenView screen={screen} tab={tab} onBack={close} bottomInset={bottomInset} />
      ) : (
        <>
          <View style={styles.dockBar}>
            <NavBarButton
              ref={moreRef}
              icon={MoreHorizontal}
              onPress={() => setMenuOpen(true)}
              active={menuOpen}
              accessibilityLabel={t('pullRequest.tab.moreActions', 'More pull request actions')}
            />
            <PullDownMenu
              visible={menuOpen}
              anchorRef={moreRef}
              groups={menuGroups}
              onClose={() => setMenuOpen(false)}
            />
          </View>
          <MobilePrTabBody
            tab={tab}
            onRetry={onRetry}
            bottomInset={bottomInset}
            footer={<PrTabBottomAction tab={tab} bottomInset={bottomInset} />}
          />
        </>
      )}
      <MobilePrTabSheets tab={tab} />
    </View>
  )
}
