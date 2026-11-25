import { Settings } from 'lucide-react-native'
import { useState } from 'react'
import { RefreshControl, ScrollView } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { AgentListRowHandlers } from '../../agents/MobileAgentListRows'
import type { HostCatalogEntry } from '../../host-catalog/host-profile'
import { MobileHomeAppUpdateCard } from '../MobileHomeAppUpdateCard'
import { MobileHomeEmptyState } from '../MobileHomeEmptyState'
import { MobileHomeHostList } from '../MobileHomeHostList'
import { MobileHomeAppMoveBanner } from '../MobileHomeAppMoveBanner'
import { MobileHomeActiveAgents } from '../MobileHomeActiveAgents'
import { MobileHomeBots } from '../MobileHomeBots'
import type { HomeBotRow } from '../bots/home-bot-rows'
import { MobileHomeTasksSection } from '../MobileHomeTasksSection'
import type { MobileHomeData } from '../use-mobile-home-data'
import { MobileHomeTabHeader, MobileHomeTabHeaderButton } from './MobileHomeTabHeader'

/** Home's first tab: bots, agents that need you or are working, the computers, and Tasks. */
export function MobileHomeFeedTab(props: {
  data: MobileHomeData
  bottomInset: number
  agentHandlers: AgentListRowHandlers
  onSeeAllAgents: () => void
  onOpenBot: (row: HomeBotRow) => void
  onSeeAllBots: () => void
  onOpenHost: (host: HostCatalogEntry) => void
  onOpenHostActions: (host: HostCatalogEntry) => void
  onPairDesktop: () => void
  onOpenTasks: (hostId: string) => void
  onOpenSettings: () => void
}) {
  const t = useMobileTranslation()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const { data } = props
  const [refreshing, setRefreshing] = useState(false)
  // Settings lives here only, so it shows on every Feed state, pairing and loading included.
  const title = (
    <MobileHomeTabHeader
      title={t('home.tabs.feed', 'Feed')}
      trailing={
        <MobileHomeTabHeaderButton
          icon={Settings}
          accessibilityLabel={t('common.settings', 'Settings')}
          onPress={props.onOpenSettings}
        />
      }
    />
  )
  // Keychain reads can outlast the splash; show the title instead of a blank frame.
  if (!data.hostCatalogLoaded) {
    return title
  }
  if (data.hostCatalog.length === 0) {
    return (
      <>
        {title}
        <MobileHomeEmptyState
          contentMaxWidth={contentMaxWidth}
          isWideLayout={isWideLayout}
          bottomInset={props.bottomInset}
          onPairDesktop={props.onPairDesktop}
        />
      </>
    )
  }
  // Pull to refresh reads every connected computer's agents and workspaces again.
  const refresh = () => {
    setRefreshing(true)
    void data.refreshAgents().finally(() => setRefreshing(false))
  }
  const hasBots = data.bots.rows.length > 0
  const hasActiveAgents = data.activeAgents.length > 0
  return (
    <>
      {title}
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: props.bottomInset },
          isWideLayout && { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.textSecondary}
            colors={[colors.textSecondary]}
          />
        }
      >
        <MobileHomeAppMoveBanner />
        <MobileHomeBots
          rows={data.bots.rows}
          onOpen={props.onOpenBot}
          onSeeAll={props.onSeeAllBots}
        />
        <MobileHomeActiveAgents
          rows={data.activeAgents}
          hosts={data.sortedHosts}
          now={data.agentList.now}
          handlers={props.agentHandlers}
          first={!hasBots}
          onSeeAll={props.onSeeAllAgents}
        />
        <MobileHomeHostList
          autoConnectHostIds={data.autoConnectHostIds}
          first={!hasBots && !hasActiveAgents}
          hostAttempts={data.hostAttempts}
          hostLastConnected={data.hostLastConnected}
          hostConnections={data.hostConnections}
          hosts={data.sortedHostCatalog}
          hostStates={data.hostStates}
          needsYouByHost={data.needsYouByHost}
          worktreeInfo={data.worktreeInfo}
          onOpen={props.onOpenHost}
          onOpenActions={props.onOpenHostActions}
          onPairDesktop={props.onPairDesktop}
        />
        <MobileHomeTasksSection connectedHosts={data.connectedHosts} onOpen={props.onOpenTasks} />
        <MobileHomeAppUpdateCard />
      </ScrollView>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  content: { paddingHorizontal: spacing.lg }
}))
