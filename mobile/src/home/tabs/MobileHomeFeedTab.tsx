import { ScrollView } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { AgentListRowHandlers } from '../../agents/MobileAgentListRows'
import type { HostCatalogEntry } from '../../host-catalog/host-profile'
import { MobileHomeAppUpdateCard } from '../MobileHomeAppUpdateCard'
import { MobileHomeEmptyState } from '../MobileHomeEmptyState'
import { MobileHomeHostList } from '../MobileHomeHostList'
import { MobileHomeAppMoveBanner } from '../MobileHomeAppMoveBanner'
import { MobileHomeActiveAgents } from '../MobileHomeActiveAgents'
import { MobileHomeTasksSection } from '../MobileHomeTasksSection'
import type { MobileHomeData } from '../use-mobile-home-data'
import { MobileHomeTabHeader } from './MobileHomeTabHeader'

/** Home's first tab: agents that need you or are working, the desktops, and Tasks. */
export function MobileHomeFeedTab(props: {
  data: MobileHomeData
  bottomInset: number
  agentHandlers: AgentListRowHandlers
  onSeeAllAgents: () => void
  onOpenHost: (host: HostCatalogEntry) => void
  onOpenHostActions: (host: HostCatalogEntry) => void
  onPairDesktop: () => void
  onOpenTasks: (hostId: string) => void
}) {
  const t = useMobileTranslation()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const { data } = props
  const title = <MobileHomeTabHeader title={t('home.tabs.feed', 'Feed')} />
  // Keychain reads can outlast the splash; show the title instead of a blank frame.
  if (!data.hostCatalogLoaded) {
    return title
  }
  if (data.hostCatalog.length === 0) {
    return (
      <MobileHomeEmptyState
        contentMaxWidth={contentMaxWidth}
        isWideLayout={isWideLayout}
        bottomInset={props.bottomInset}
        onPairDesktop={props.onPairDesktop}
      />
    )
  }
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
      >
        <MobileHomeAppMoveBanner />
        <MobileHomeActiveAgents
          rows={data.activeAgents}
          hosts={data.sortedHosts}
          now={data.agentList.now}
          handlers={props.agentHandlers}
          onSeeAll={props.onSeeAllAgents}
        />
        <MobileHomeHostList
          autoConnectHostIds={data.autoConnectHostIds}
          first={!hasActiveAgents}
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
