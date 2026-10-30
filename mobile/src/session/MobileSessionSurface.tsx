import { useContext, useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
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
import { useNow } from '../hooks/use-now'
import { getMobileTerminalTabHostAgentIdentity } from './mobile-terminal-tab-agent'
import { mobileSessionTabCardContent } from './mobile-session-tab-card-content'
import { MobileSessionTabCardFooter } from './MobileSessionTabCardFooter'
import { useSessionSideRail } from './session-side-rail'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
    controller.bulkCloseConfirm.visible ||
    controller.leaveDrafts != null ||
    controller.discardMarkdownTarget != null ||
    controller.renameTarget != null ||
    controller.showCreateBrowserModal ||
    controller.showCustomKeyModal ||
    controller.showDictationSetup ||
    controller.deleteKeyTarget != null
  )
  const details = useSessionTitleCard(besideTabs, obscured, controller.visibleTabs)
  const { missingTab } = details
  const tab = useMemo(
    () =>
      details.tabId
        ? controller.visibleTabs.find((candidate) => candidate.id === details.tabId)
        : undefined,
    [controller.visibleTabs, details.tabId]
  )
  const hostAgentIdentity = useMemo(
    () => (tab ? getMobileTerminalTabHostAgentIdentity(tab, controller.terminals) : undefined),
    [tab, controller.terminals]
  )
  const now = useNow(60_000, details.active && tab != null)
  const tabContent = useMemo(
    () => (tab ? mobileSessionTabCardContent(tab, hostAgentIdentity, now) : null),
    [tab, hostAgentIdentity, now, t]
  )
  const footer = useMemo(
    () => (tabContent ? <MobileSessionTabCardFooter content={tabContent} /> : null),
    [tabContent]
  )
  const rail = useSessionSideRail(controller, details)
  const contentRow = useMemo(
    () => <MobileSessionContentRow controller={controller} keysInRail={rail.keysInRail} />,
    [controller, rail.keysInRail]
  )
  useDetailCardScope({
    ...details,
    openerRef: details.scopeOpenerRef,
    active: details.active && !missingTab,
    obscured: obscured || missingTab
  })
  // Only a proven local record belongs to this route's desktop or server.
  const hostName =
    controller.worktreeHostId === 'local' ? (server ? server.name : controller.hostName) : null
  return (
    <View ref={setMobileSessionRootRef} style={styles.container}>
      <View style={styles.kavInner}>
        <MobileSessionHeader
          controller={controller}
          details={details}
          backInRail={rail.backInRail}
        />
        {contentRow}
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
              active={details.active && !missingTab}
              obscured={obscured || missingTab}
              onSettled={details.onSettled}
              title={
                tabContent?.title ??
                (controller.worktreeName || t('session.header.terminalTitle', 'Terminal'))
              }
              detail={tabContent ? tabContent.detail : controller.worktreePath}
              footer={
                tabContent ? (
                  footer
                ) : hostName ? (
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
