import { View, Text, Pressable } from 'react-native'
import { AlertTriangle, X } from 'lucide-react-native'
import { SessionDockColumn } from './SessionDockColumn'
import { dismissMobileSessionCreateWarningState } from './mobile-session-create-warning-state'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionActiveContent } from './MobileSessionActiveContent'
import { MobileSessionCommandDock } from './MobileSessionCommandDock'
import { MobileDictationStatusAnnouncement } from './MobileDictationStatusAnnouncement'
import { ComposerUsageClientContext } from '../composer-usage/composer-usage-client-context'
import {
  sideStripMargin,
  sideStripPadding,
  useSessionSideStripInset
} from './session-side-strip-inset'

export function MobileSessionContentRow({ controller }: { controller: MobileSessionController }) {
  useMobileColorScheme()
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
    handleFileOpenStart,
    handleOpenedFileDiff,
    handleSessionContentRowLayout,
    client,
    connState
  } = controller
  const strip = useSessionSideStripInset(canDockPanel && activePanel !== null)
  return (
    <View
      style={[styles.sessionContentRow, sideStripPadding(strip.row)]}
      onLayout={handleSessionContentRowLayout}
    >
      <View style={styles.sessionContentMain}>
        {createWarning ? (
          <View style={[styles.createWarningBanner, sideStripMargin(strip.main)]}>
            <AlertTriangle size={16} color={colors.statusAmber} strokeWidth={2.2} />
            <Text style={styles.createWarningText}>{createWarning}</Text>
            <Pressable
              style={styles.createWarningDismiss}
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
        <ComposerUsageClientContext.Provider value={connState === 'connected' ? client : null}>
          <MobileSessionActiveContent controller={controller} />
          {/* Why: translate instead of resize so keyboard toggles don't trigger a server-side PTY viewport change. */}
          <View style={sideStripMargin(strip.main)}>
            <MobileSessionCommandDock controller={controller} />
          </View>
        </ComposerUsageClientContext.Provider>
        <MobileDictationStatusAnnouncement dictation={dictation} />
      </View>
      {canDockPanel && activePanel !== null && (
        <SessionDockColumn
          activePanel={activePanel}
          hostId={hostId}
          worktreeId={worktreeId}
          name={worktreeName || ''}
          availableWidth={sessionContentRowWidth}
          onRequestClose={() => setActivePanel(null)}
          onFileOpenStart={handleFileOpenStart}
          onOpenedFileDiff={handleOpenedFileDiff}
        />
      )}
    </View>
  )
}
