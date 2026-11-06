import { ScrollView } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useResponsiveLayout } from '../../layout/responsive-layout'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { HostCatalogEntry } from '../../transport/types'
import type { HomeJumpBackInRow } from '../../worktree/home-jump-back-in'
import { MobileHomeAppUpdateCard } from '../MobileHomeAppUpdateCard'
import { MobileHomeEmptyState } from '../MobileHomeEmptyState'
import { MobileHomeHostList } from '../MobileHomeHostList'
import { MobileHomeJumpBackIn } from '../MobileHomeJumpBackIn'
import { MobileHomeTasksSection } from '../MobileHomeTasksSection'
import type { MobileHomeData } from '../use-mobile-home-data'
import { MobileHomeTabHeader } from './MobileHomeTabHeader'

/** Home's first tab: agents to get back to, the desktops, and Tasks. */
export function MobileHomeFeedTab(props: {
  data: MobileHomeData
  bottomInset: number
  onOpenWorktree: (row: HomeJumpBackInRow) => void
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
  const hasAgents = data.jumpBackInRows.length > 0
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
        <MobileHomeJumpBackIn
          rows={data.jumpBackInRows}
          hosts={data.sortedHostCatalog}
          first
          onOpen={props.onOpenWorktree}
        />
        <MobileHomeHostList
          autoConnectHostIds={data.autoConnectHostIds}
          first={!hasAgents}
          hostAttempts={data.hostAttempts}
          hostLastConnected={data.hostLastConnected}
          hostConnections={data.hostConnections}
          hosts={data.sortedHostCatalog}
          hostStates={data.hostStates}
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
