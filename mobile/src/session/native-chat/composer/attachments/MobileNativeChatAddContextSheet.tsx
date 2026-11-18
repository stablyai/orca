import { useState } from 'react'
import { View } from 'react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { BottomDrawer } from '../../../../components/bottom-drawer/BottomDrawer'
import { useBottomDrawerFollowUp } from '../../../../components/bottom-drawer/use-bottom-drawer-follow-up'
import { SheetHeader } from '../../../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../../../components/sheets/SheetPrimaryButton'
import {
  ActionSheetContent,
  type ActionSheetAction
} from '../../../../components/sheets/ActionSheetModal'
import type { RecentPhotoLibrary } from '../../../../platform/media-picking/media-picker-contract'
import { BRIDGE_MEDIA_MAX_LIVE_HANDLES } from '../../../../mobile-web-shell/bridge/native-capabilities/bridge-media-verbs'
import { MobileRecentPhotoStrip } from './MobileRecentPhotoStrip'
import { useMobileRecentPhotos } from './use-mobile-recent-photos'

const NO_SELECTION: ReadonlySet<string> = new Set()

/** The composer's + sheet: Camera and recent photos up top, the full Photos picker in the header, other context below. */
export function MobileNativeChatAddContextSheet({
  visible,
  onClose,
  onPhotos,
  onCamera,
  onRecentPhotos,
  library,
  onAfterClose,
  actions
}: {
  visible: boolean
  onClose: () => void
  onPhotos: (() => void) | undefined
  onCamera: (() => void) | undefined
  onRecentPhotos: ((ids: readonly string[]) => void) | undefined
  /** In-process only: the app's own screens and the shell's sheet, never the served page. */
  library: RecentPhotoLibrary | null
  /** Runs after the sheet slid away and any chosen action ran. */
  onAfterClose?: () => void
  actions: ActionSheetAction[]
}): React.JSX.Element {
  const t = useMobileTranslation()
  const recent = useMobileRecentPhotos(onRecentPhotos ? library : null, visible)
  const [selected, setSelected] = useState(NO_SELECTION)
  const { closeThen, drawerProps } = useBottomDrawerFollowUp(onClose)
  // Native pickers cannot present over the sheet, so each one waits for it to slide away.
  const later = (action: (() => void) | undefined) => (action ? () => closeThen(action) : undefined)

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (!next.delete(id)) {
        next.add(id)
      }
      return next
    })
  const attachSelected = () => {
    const ids = [...selected]
    closeThen(() => onRecentPhotos?.(ids))
  }

  return (
    <BottomDrawer
      visible={visible}
      onClose={drawerProps.onClose}
      onAfterClose={() => {
        setSelected(NO_SELECTION)
        drawerProps.onAfterClose()
        onAfterClose?.()
      }}
      dragContentToDismiss
    >
      <SheetHeader
        title={t('session.nativeChatAddContext.title', 'Add context')}
        onClose={onClose}
        trailing={
          onPhotos
            ? {
                label: t('session.nativeChatAddContext.photos', 'Photos'),
                onPress: () => closeThen(onPhotos)
              }
            : undefined
        }
      />
      <MobileRecentPhotoStrip
        library={onRecentPhotos ? library : null}
        access={recent.access}
        ids={recent.ids}
        selected={selected}
        selectionFull={selected.size >= BRIDGE_MEDIA_MAX_LIVE_HANDLES}
        onCamera={later(onCamera)}
        onTogglePhoto={toggle}
        onManage={() => closeThen(() => void library?.manage())}
      />
      {selected.size > 0 ? (
        <View style={styles.attach}>
          <SheetPrimaryButton
            label={t('session.nativeChatAddContext.attachSelected', 'Attach ({{count}})', {
              count: selected.size
            })}
            onPress={attachSelected}
          />
        </View>
      ) : null}
      {actions.length > 0 ? (
        <ActionSheetContent
          actions={actions.map((action) => ({
            ...action,
            onPress: () => closeThen(action.onPress)
          }))}
        />
      ) : null}
    </BottomDrawer>
  )
}

const styles = themedStyleSheet(() => ({
  attach: {
    paddingBottom: spacing.md
  }
}))
