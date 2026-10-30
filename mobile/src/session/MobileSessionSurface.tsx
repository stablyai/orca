import { useContext } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionContentRow } from './MobileSessionContentRow'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSheets } from './MobileSessionSheets'
import { MobileWorkerAutoCloseStrip } from './MobileWorkerAutoCloseStrip'
import { DetailCardLayer } from '../components/detail-card-host'
import { AnchoredDetailCard } from '../components/AnchoredDetailCard'
import { StatusDot } from '../components/StatusDot'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { WorkspaceServerContext } from '../transport/use-workspace-client'
import { useSessionTitleCard } from './use-session-title-card'
import { useDetailCardScope } from '../components/use-detail-card-scope'
import { useShellSideRail } from '../layout/use-shell-side-rail'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { setMobileSessionRootRef } = controller
  const server = useContext(WorkspaceServerContext)
  const layout = useResponsiveLayout()
  const sideRail = useShellSideRail()
  const hasTabs = controller.visibleTabs.length > 0
  const besideTabs = (layout.isLandscapePhone || sideRail) && hasTabs
  const titleVisible =
    !sideRail || !hasTabs || controller.showConnectionRetry || controller.connectionEscalated
  // The compact Duo header removes the opener, so its card must yield with it.
  const obscured = Boolean(
    !titleVisible ||
    controller.showHeaderMoreActions ||
    controller.showCreateTabDrawer ||
    controller.showTerminalLayout ||
    (controller.showQuickCommands && controller.quickCommandsSupported === true) ||
    controller.pendingDiffNotesDelivery != null ||
    controller.actionTarget != null ||
    controller.markdownActionTarget != null ||
    controller.fileActionTarget != null ||
    controller.browserActionTarget != null ||
    controller.agentSessionActionTarget != null ||
    controller.bulkCloseConfirm.visible ||
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
        <MobileWorkerAutoCloseStrip controller={controller} />
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
              bounds={details.bounds}
              contentRef={details.contentRef}
              boundaryRefs={details.boundaryRefs}
              active={details.active}
              obscured={obscured}
              onSettled={details.onSettled}
              title={controller.worktreeName || t('session.header.terminalTitle', 'Terminal')}
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
