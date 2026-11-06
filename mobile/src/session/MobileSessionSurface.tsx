import { useContext, useMemo } from 'react'
import { Text, View } from 'react-native'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionContentRow } from './MobileSessionContentRow'
import { MobileSessionHeader } from './MobileSessionHeader'
import { MobileSessionSheets } from './MobileSessionSheets'
import { MobileWorkerAutoCloseStrip } from './MobileWorkerAutoCloseStrip'
import { AnchoredDetailCardLayer } from '../components/AnchoredDetailCard'
import { StatusDot } from '../components/StatusDot'
import { useResponsiveLayout } from '../layout/responsive-layout'
import { WorkspaceServerContext } from '../transport/workspace-server-context'
import { useSessionTitleCard } from './use-session-title-card'
import { useDetailCardScope } from '../components/use-detail-card-scope'
import { useShellSideRail } from '../layout/use-shell-side-rail'
import { useReleasedSideInset } from '../layout/released-side-inset'
import { sideStripPadding } from './session-side-strip-inset'
import { DuoRailBackButton } from './DuoRailBackButton'
import { DuoRailJumpHost, DuoRailJumpOverlay } from './duo-rail-jump-controls'
import { useSessionRailBack } from './use-duo-rail-back'

export function MobileSessionSurface({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { setMobileSessionRootRef } = controller
  const server = useContext(WorkspaceServerContext)
  const layout = useResponsiveLayout()
  const sideRail = useShellSideRail()
  const releasedStrip = useReleasedSideInset()
  const hasTabs = controller.visibleTabs.length > 0
  const besideTabs = (layout.isLandscapePhone || sideRail) && hasTabs
  const titleVisible =
    !sideRail || !hasTabs || controller.showConnectionRetry || controller.connectionEscalated
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
  const contentRow = useMemo(
    () => <MobileSessionContentRow controller={controller} />,
    [controller]
  )
  useDetailCardScope({ ...details, obscured })
  // Only a proven local record belongs to this route's desktop or server.
  const hostName =
    controller.worktreeHostId === 'local' ? (server ? server.name : controller.hostName) : null
  const onRailBack = useSessionRailBack(() => {
    if (!details.closeFirst()) {
      controller.requestLeaveSession()
    }
  })
  return (
    <DuoRailJumpHost
      chatVisible={controller.showNativeChat}
      keyboardInset={controller.keyboardHeight}
    >
      <View ref={setMobileSessionRootRef} style={styles.container}>
        <View style={styles.kavInner}>
          <MobileSessionHeader controller={controller} details={details} />
          <View style={sideStripPadding(releasedStrip)}>
            <MobileWorkerAutoCloseStrip controller={controller} />
          </View>
          {contentRow}
        </View>
        <DuoRailBackButton
          chatVisible={controller.showNativeChat}
          keyboardInset={controller.keyboardHeight}
          onBack={onRailBack}
        />
        <DuoRailJumpOverlay />
        <AnchoredDetailCardLayer
          card={details}
          obscured={obscured}
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
        <MobileSessionSheets controller={controller} />
      </View>
    </DuoRailJumpHost>
  )
}
