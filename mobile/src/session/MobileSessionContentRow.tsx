import { useContext } from 'react'
import { View, Text, Pressable } from 'react-native'
import { AlertTriangle, X } from 'lucide-react-native'
import { SessionDockColumn } from './SessionDockColumn'
import { SidebarPageDragContext } from './tabs/sidebar-page-drag'
import { useSidebarContentSwipe } from './tabs/use-sidebar-content-swipe'
import { dismissMobileSessionCreateWarningState } from './tabs/mobile-session-create-warning-state'
import { pressedStyle } from '../theme/mobile-theme'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { stylesSheet } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionActiveContent } from './MobileSessionActiveContent'
import { MobileSessionCommandDock } from './MobileSessionCommandDock'
import {
  sideStripMargin,
  sideStripPadding,
  useSessionSideStripInset
} from './session-side-strip-inset'
import { MobileDictationLiveContext } from '../dictation/mobile-dictation-live-context'
import { useMobileDictationLive } from '../dictation/use-mobile-dictation-live'
import { useThemedStyles } from '../theme/themed-styles'
import { ComposerUsageSheetHost } from '../composer-usage/ComposerUsageSheetHost'
import {
  ComposerUsageClientContext,
  ComposerUsageTabAgentContext
} from '../composer-usage/composer-usage-client-context'
import { getMobileTerminalTabHostAgentIdentity } from './tabs/mobile-terminal-tab-agent'

export function MobileSessionContentRow({ controller }: { controller: MobileSessionController }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const {
    hostId,
    worktreeId,
    worktreeName,
    activePanel,
    setActivePanel,
    sessionContentRowWidth,
    canDockPanel,
    setCreateWarningState,
    createWarning,
    dictation,
    cancelDictation,
    handleSessionContentRowLayout,
    client,
    connState
  } = controller
  const tabAgent =
    (controller.activeSessionTab &&
      getMobileTerminalTabHostAgentIdentity(controller.activeSessionTab, controller.terminals)) ??
    null
  const strip = useSessionSideStripInset(canDockPanel && activePanel !== null)
  const dictationLive = useMobileDictationLive(dictation, cancelDictation, hostId)
  // A leftward swipe across a chat, a note or a terminal opens the tabs sidebar (a terminal decides
  // its own touches and hands the swipe over). A browser tab's page and diffs take their own swipes.
  const swipeOpensSidebar = useSidebarContentSwipe(
    useContext(SidebarPageDragContext),
    controller.showNativeChat ||
      controller.activeMarkdownTab != null ||
      controller.activeSessionTab?.type === 'terminal'
  )
  return (
    <View
      style={[styles.sessionContentRow, sideStripPadding(strip.row)]}
      onLayout={handleSessionContentRowLayout}
    >
      <View ref={swipeOpensSidebar} style={styles.sessionContentMain}>
        {createWarning ? (
          <View style={[styles.createWarningBanner, sideStripMargin(strip.main)]}>
            <AlertTriangle size={16} color={colors.statusAmber} strokeWidth={2.2} />
            <Text style={styles.createWarningText}>{createWarning}</Text>
            <Pressable
              style={({ pressed }) => [styles.createWarningDismiss, pressed && pressedStyle]}
              onPress={() => setCreateWarningState(dismissMobileSessionCreateWarningState)}
              accessibilityLabel={t(
                'session.contentRow.dismissCreationWarning',
                'Dismiss workspace creation warning'
              )}
              hitSlop={8}
            >
              <X size={16} color={colors.textMuted} strokeWidth={2.2} />
            </Pressable>
          </View>
        ) : null}
        <MobileDictationLiveContext.Provider value={dictationLive}>
          <ComposerUsageClientContext.Provider value={connState === 'connected' ? client : null}>
            <ComposerUsageTabAgentContext.Provider value={tabAgent}>
              <ComposerUsageSheetHost>
                <MobileSessionActiveContent controller={controller} />
                {/* Why: translate instead of resize so keyboard toggles don't trigger a server-side PTY viewport change. */}
                <View style={sideStripMargin(strip.main)}>
                  <MobileSessionCommandDock controller={controller} />
                </View>
              </ComposerUsageSheetHost>
            </ComposerUsageTabAgentContext.Provider>
          </ComposerUsageClientContext.Provider>
        </MobileDictationLiveContext.Provider>
      </View>
      {canDockPanel && activePanel !== null && (
        <SessionDockColumn
          activePanel={activePanel}
          hostId={hostId}
          worktreeId={worktreeId}
          name={worktreeName || ''}
          availableWidth={sessionContentRowWidth}
          onRequestClose={() => setActivePanel(null)}
        />
      )}
    </View>
  )
}
