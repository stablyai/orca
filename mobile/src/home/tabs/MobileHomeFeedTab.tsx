import { useMemo } from 'react'
import { ScrollView } from 'react-native'
import type { CloudWorkspace } from '../../cloud/cloud-control-plane-client'
import { cloudDeviceLabel } from '../../cloud/cloud-device-label'
import { useCloudHostIds } from '../../cloud/use-cloud-host-ids'
import { useCloudEnrollment } from '../../cloud/use-cloud-workspaces'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { AgentListRowHandlers } from '../../agents/MobileAgentListRows'
import type { HostCatalogEntry } from '../../transport/hosts/host-profile'
import { MobileHomeAppUpdateCard } from '../MobileHomeAppUpdateCard'
import { MobileHomeCloudSection } from '../MobileHomeCloudSection'
import { MobileHomeEmptyState } from '../MobileHomeEmptyState'
import { MobileHomeHostList } from '../MobileHomeHostList'
import { MobileHomeNeedsYou } from '../MobileHomeNeedsYou'
import { MobileHomeTasksSection } from '../MobileHomeTasksSection'
import type { MobileHomeData } from '../use-mobile-home-data'
import { MobileHomeTabHeader } from './MobileHomeTabHeader'

/** Home's first tab: agents that need you, the desktops, and Tasks. */
export function MobileHomeFeedTab(props: {
  data: MobileHomeData
  bottomInset: number
  agentHandlers: AgentListRowHandlers
  onSeeAllAgents: () => void
  onOpenHost: (host: HostCatalogEntry) => void
  onOpenHostActions: (host: HostCatalogEntry) => void
  onPairDesktop: () => void
  onOpenTasks: (hostId: string) => void
  onOpenCloudWorkspace: (workspace: CloudWorkspace) => void
  onNewCloudWorkspace: () => void
  onManageCloudAccess: () => void
}) {
  const t = useMobileTranslation()
  const { isWideLayout, contentMaxWidth } = useResponsiveLayout()
  const { data } = props
  const enrollment = useCloudEnrollment()
  const cloudHostIds = useCloudHostIds(enrollment)
  // Cloud VMs are paired hosts too, but they belong in Cloud, not under Desktops.
  const desktopCatalog = useMemo(
    () => data.sortedHostCatalog.filter((host) => !cloudHostIds.has(host.id)),
    [data.sortedHostCatalog, cloudHostIds]
  )
  const enrollDesktop = useMemo(() => {
    const host = data.connectedHosts.find((entry) => !cloudHostIds.has(entry.id))
    const client = host
      ? data.allClients.find((entry) => entry.hostId === host.id)?.client
      : undefined
    return host && client ? { name: host.personalName ?? host.name, client } : null
  }, [data.connectedHosts, data.allClients, cloudHostIds])
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
  const needsYou = data.agentsNeedingYou.length > 0
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
        <MobileHomeNeedsYou
          rows={data.agentsNeedingYou}
          hosts={data.sortedHosts}
          now={data.agentList.now}
          handlers={props.agentHandlers}
          onSeeAll={props.onSeeAllAgents}
        />
        <MobileHomeHostList
          autoConnectHostIds={data.autoConnectHostIds}
          first={!needsYou}
          hostAttempts={data.hostAttempts}
          hostLastConnected={data.hostLastConnected}
          hostConnections={data.hostConnections}
          hosts={desktopCatalog}
          hostStates={data.hostStates}
          needsYouByHost={data.needsYouByHost}
          worktreeInfo={data.worktreeInfo}
          onOpen={props.onOpenHost}
          onOpenActions={props.onOpenHostActions}
          onPairDesktop={props.onPairDesktop}
        />
        <MobileHomeCloudSection
          enrollment={enrollment}
          enrollDesktop={enrollDesktop}
          deviceLabel={cloudDeviceLabel()}
          onOpenWorkspace={props.onOpenCloudWorkspace}
          onNewWorkspace={props.onNewCloudWorkspace}
          onManageAccess={props.onManageCloudAccess}
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
