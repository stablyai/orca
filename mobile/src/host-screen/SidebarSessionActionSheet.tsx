import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/BottomDrawer'
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
  const sessionKey = session ? `${session.worktree.worktreeId}\0${session.paneKey}` : null
  const [phase, setPhase] = useState<{ key: string; closing: boolean } | null>(null)
  // The drawer stays mounted, so a leftover confirm step would reopen on the next long-press.
  useEffect(() => {
    if (session === null) {
      setPhase(null)
    }
  }, [session])
  const confirming = phase?.key === sessionKey && sessionKey !== null
  const closing = confirming && phase?.closing === true
  const confirmClose = () => {
    if (!session || !sessionKey || closing) {
      return
    }
    setPhase({ key: sessionKey, closing: true })
    onCloseSession(session)
  }

  return (
    <BottomDrawer visible={session != null} onClose={onDismiss}>
      {session == null ? null : (
        <SessionSheetBody
          session={session}
          confirming={confirming}
          closing={closing}
          onOpen={onOpen}
          onConfirm={confirmClose}
          onAskConfirm={() => {
            if (sessionKey) {
              setPhase({ key: sessionKey, closing: false })
            }
          }}
          onCancelConfirm={() => setPhase(null)}
        />
      )}
    </BottomDrawer>
  )
}

function SessionSheetBody({
  session,
  confirming,
  closing,
  onOpen,
  onAskConfirm,
  onCancelConfirm,
  onConfirm
}: {
  session: SidebarSessionAction
  confirming: boolean
  closing: boolean
  onOpen: (session: SidebarSessionAction) => void
  onAskConfirm: () => void
  onCancelConfirm: () => void
  onConfirm: () => void
}) {
  const t = useMobileTranslation()
  if (confirming) {
    return (
      <SessionCloseConfirm
        label={session.label}
        closing={closing}
        onCancel={onCancelConfirm}
        onConfirm={onConfirm}
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
          onPress: onAskConfirm
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
