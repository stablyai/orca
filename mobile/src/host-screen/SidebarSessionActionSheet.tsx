import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import type { SidebarSessionAction } from './sidebar-session-action'

type Props = {
  session: SidebarSessionAction | null
  onDismiss: () => void
  onOpen: (session: SidebarSessionAction) => void
  onCloseSession: (session: SidebarSessionAction) => void
}

export function SidebarSessionActionSheet({ session, onDismiss, onOpen, onCloseSession }: Props) {
  useMobileColorScheme()
  return (
    <BottomDrawer visible={session != null} onClose={onDismiss}>
      {session == null ? null : (
        <SessionSheetBody session={session} onOpen={onOpen} onCloseSession={onCloseSession} />
      )}
    </BottomDrawer>
  )
}

function SessionSheetBody({
  session,
  onOpen,
  onCloseSession
}: {
  session: SidebarSessionAction
  onOpen: (session: SidebarSessionAction) => void
  onCloseSession: (session: SidebarSessionAction) => void
}) {
  const t = useMobileTranslation()
  const [phase, setPhase] = useState<'ask' | 'closing' | null>(null)
  const confirming = phase !== null
  const closing = phase === 'closing'
  const confirmClose = () => {
    if (closing) {
      return
    }
    setPhase('closing')
    onCloseSession(session)
  }

  if (confirming) {
    return (
      <SessionCloseConfirm
        label={session.label}
        closing={closing}
        onCancel={() => setPhase(null)}
        onConfirm={confirmClose}
      />
    )
  }
  return (
    <ActionSheetContent
      title={session.label}
      titleLines={2}
      actions={[
        {
          id: 'open',
          label: t('hostScreen.hostScreenOverlays.openSession', 'Open {{name}}', {
            name: session.label
          }),
          lines: 2,
          onPress: () => onOpen(session)
        },
        {
          id: 'close',
          label: t('common.close', 'Close'),
          destructive: true,
          onPress: () => setPhase('ask')
        }
      ]}
    />
  )
}

function SessionCloseConfirm({
  label,
  closing,
  onCancel,
  onConfirm
}: {
  label: string
  closing: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useMobileTranslation()
  return (
    <View>
      <View style={styles.confirmContent}>
        <Text style={styles.confirmTitle}>{t('common.close', 'Close')}</Text>
        <Text style={styles.confirmMessage} numberOfLines={2}>
          {t('hostScreen.hostScreenOverlays.closeSessionConfirm', 'Close "{{name}}"?', {
            name: label
          })}
        </Text>
      </View>
      <View style={styles.confirmButtons}>
        <Pressable
          style={({ pressed }) => [
            styles.confirmBtn,
            styles.confirmBtnCancel,
            pressed && styles.confirmBtnPressed
          ]}
          onPress={onCancel}
        >
          <Text style={styles.confirmBtnCancelText}>{t('common.cancel', 'Cancel')}</Text>
        </Pressable>
        <Pressable
          disabled={closing}
          style={({ pressed }) => [
            styles.confirmBtn,
            styles.confirmBtnDestructive,
            pressed && !closing && styles.confirmBtnPressed
          ]}
          onPress={onConfirm}
        >
          <Text style={styles.confirmBtnDestructiveText}>{t('common.close', 'Close')}</Text>
        </Pressable>
      </View>
    </View>
  )
}
