import { useContext } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionContentRow } from './MobileSessionContentRow'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSheets } from './MobileSessionSheets'
import { DetailCardLayer } from '../components/detail-card-host'
import { AnchoredDetailCard } from '../components/AnchoredDetailCard'
import { StatusDot } from '../components/StatusDot'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { WorkspaceServerContext } from '../transport/use-workspace-client'
import { useSessionTitleCard } from './use-session-title-card'
import { useDetailCardScope } from '../components/use-detail-card-scope'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  const { setMobileSessionRootRef } = controller
  const server = useContext(WorkspaceServerContext)
  const besideTabs = useResponsiveLayout().isLandscapePhone && controller.visibleTabs.length > 0
  const obscured = Boolean(
    controller.showHeaderMoreActions ||
    controller.showCreateTabDrawer ||
    (controller.showQuickCommands && controller.quickCommandsSupported === true) ||
    controller.pendingDiffNotesDelivery != null ||
    controller.actionTarget != null ||
    controller.markdownActionTarget != null ||
    controller.fileActionTarget != null ||
    controller.browserActionTarget != null ||
    controller.agentSessionActionTarget != null ||
    controller.leaveDrafts != null ||
    controller.discardMarkdownTarget != null ||
    controller.renameTarget != null ||
    controller.showCreateBrowserModal ||
    controller.showCustomKeyModal ||
    controller.showDictationSetup ||
    controller.deleteKeyTarget != null
  )
  const details = useSessionTitleCard(besideTabs, obscured)
  useDetailCardScope({ ...details, obscured })
  // Only a proven local record belongs to this route's desktop or server.
  const hostName =
    controller.worktreeHostId === 'local' ? (server ? server.name : controller.hostName) : null
  return (
    <View ref={setMobileSessionRootRef} style={styles.container}>
      <View style={styles.kavInner}>
        <MobileSessionHeader controller={controller} details={details} />
        {/* Content-row host (KTD2): on wide, content shares this row with the docked panel as the flex-1 left child. */}
        <MobileSessionContentRow controller={controller} />
      </View>
      <DetailCardLayer>
        <View
          ref={details.layerRef}
          collapsable={false}
          pointerEvents="box-none"
          onLayout={details.onLayout}
          style={detailLayer}
        >
          {details.visual ? (
            <AnchoredDetailCard
              {...details.visual}
              trigger={details.trigger}
              bounds={details.bounds}
              viewport={details.viewport}
              contentRef={details.contentRef}
              onDismiss={details.dismiss}
              onSettled={details.onSettled}
              title={controller.worktreeName || 'Terminal'}
              detail={controller.worktreePath}
              footer={
                hostName ? (
                  <>
                    <StatusDot state={controller.connState} />
                    <Text style={styles.sessionMetaText}>{hostName}</Text>
                  </>
                ) : null
              }
            />
          ) : null}
        </View>
      </DetailCardLayer>
      <MobileSessionSheets controller={controller} />
    </View>
  )
}

const detailLayer = { ...StyleSheet.absoluteFillObject, zIndex: 1000 }
