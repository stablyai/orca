import { useCallback, useLayoutEffect, useRef } from 'react'
import { View, Text, Pressable } from 'react-native'
import { AlertTriangle, X } from 'lucide-react-native'
import { SessionDockColumn } from './SessionDockColumn'
import { dismissMobileSessionCreateWarningState } from './tabs/mobile-session-create-warning-state'
import { colors, pressedStyle } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { MobileSessionActiveContent } from './MobileSessionActiveContent'
import { MobileSessionCommandDock } from './MobileSessionCommandDock'
import { MobileDictationStatusAnnouncement } from '../dictation/MobileDictationStatusAnnouncement'
import { MobileDictationLiveContext } from '../dictation/mobile-dictation-live-context'
import { useMobileDictationLive } from '../dictation/use-mobile-dictation-live'
import { useMobileDictationAnnouncements } from '../dictation/use-mobile-dictation-announcements'

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
    cancelDictation,
    handleSessionContentRowLayout
  } = controller
  // ✕ tells the announcer the next idle is a cancel, so a cancel while finishing isn't read as "Inserted."
  const noteCancelRef = useRef(() => {})
  const cancelAndNote = useCallback(() => {
    noteCancelRef.current()
    cancelDictation()
  }, [cancelDictation])
  const dictationLive = useMobileDictationLive(dictation, cancelAndNote, hostId)
  const announcements = useMobileDictationAnnouncements(dictation, dictationLive.computerName)
  const { noteCancel } = announcements
  useLayoutEffect(() => {
    noteCancelRef.current = noteCancel
  }, [noteCancel])
  return (
    <View style={styles.sessionContentRow} onLayout={handleSessionContentRowLayout}>
      <View style={styles.sessionContentMain}>
        {createWarning ? (
          <View style={styles.createWarningBanner}>
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
          <MobileSessionActiveContent controller={controller} />
          {/* Why: translate instead of resize so keyboard toggles don't trigger a server-side PTY viewport change. */}
          <MobileSessionCommandDock controller={controller} />
        </MobileDictationLiveContext.Provider>
        <MobileDictationStatusAnnouncement text={announcements.liveText} />
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
