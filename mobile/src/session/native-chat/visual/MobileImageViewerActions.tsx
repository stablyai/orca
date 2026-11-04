import { useMemo, useState } from 'react'
import { Pressable } from 'react-native'
import { Copy, Download, Share } from 'lucide-react-native'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { TransientToast, useTransientToast } from '../../../components/TransientToast'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { BridgeImageOperation } from '../../../mobile-web-shell/bridge/bridge-image-verbs'
import { useImageActions } from '../../../platform/image-actions'
import { ImageActionRefusedError } from '../../../platform/image-actions-contract'
import { colors, feedback } from '../../../theme/mobile-theme'
import type { ImageViewerActionsProps } from './MobileNativeChatImageViewer'

function failureMessage(t: Translate, operation: BridgeImageOperation, error: unknown): string {
  if (error instanceof ImageActionRefusedError) {
    return error.reason === 'photos-access-denied'
      ? t('chat.nativeChatImageViewer.photosAccessDenied', 'Allow Orca to add photos in Settings')
      : t('chat.nativeChatImageViewer.imageTooLarge', 'This image is too large')
  }
  if (operation === 'copy') {
    return t('chat.nativeChatImageViewer.copyFailed', "Couldn't copy image")
  }
  return operation === 'save'
    ? t('chat.nativeChatImageViewer.saveFailed', "Couldn't save image")
    : t('chat.nativeChatImageViewer.shareFailed', "Couldn't share image")
}

/** The viewer's Share button and sheet: copy, save to the photo library, or the system share sheet. Absent on shells without native.image.act and for images the phone cannot act on. */
export function MobileImageViewerActions({
  uri,
  buttonStyle,
  toastInset
}: ImageViewerActionsProps): React.JSX.Element | null {
  const t = useMobileTranslation()
  const imageActions = useImageActions()
  const act = useMemo(() => imageActions?.forImage(uri) ?? null, [imageActions, uri])
  const [menuOpen, setMenuOpen] = useState(false)
  const { message, showToast } = useTransientToast()
  // The shell stages one image at a time, so a second action waits for the first to finish.
  const [busy, setBusy] = useState(false)
  if (!act) {
    return null
  }
  const run = (operation: BridgeImageOperation) => {
    setBusy(true)
    act(operation)
      .then(
        () => {
          if (operation === 'copy') {
            showToast(t('chat.nativeChatImageViewer.imageCopied', 'Image copied'))
          } else if (operation === 'save') {
            showToast(t('chat.nativeChatImageViewer.imageSaved', 'Image saved'))
          }
        },
        (error: unknown) => showToast(failureMessage(t, operation, error))
      )
      .finally(() => setBusy(false))
  }
  return (
    <>
      <Pressable
        style={({ pressed }) => [buttonStyle, pressed && { opacity: feedback.pressedOpacity }]}
        onPress={() => setMenuOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('chat.nativeChatImageViewer.imageActions', 'Image actions')}
      >
        <Share size={20} color={colors.textPrimary} strokeWidth={2} />
      </Pressable>
      <ActionSheetModal
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        actions={[
          {
            id: 'copy',
            label: t('chat.nativeChatImageViewer.copyImage', 'Copy image'),
            icon: Copy,
            disabled: busy,
            onPress: () => run('copy')
          },
          {
            id: 'save',
            label: t('chat.nativeChatImageViewer.saveImage', 'Save image'),
            icon: Download,
            closeBeforePress: true,
            disabled: busy,
            onPress: () => run('save')
          },
          {
            id: 'share',
            label: t('chat.nativeChatImageViewer.share', 'Share…'),
            icon: Share,
            closeBeforePress: true,
            disabled: busy,
            onPress: () => run('share')
          }
        ]}
      />
      <TransientToast message={message} bottomInset={toastInset} />
    </>
  )
}
