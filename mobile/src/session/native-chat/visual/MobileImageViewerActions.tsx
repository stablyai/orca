import { useMemo, useState } from 'react'
import { Pressable } from 'react-native'
import { Copy, Download, Share, type LucideIcon } from 'lucide-react-native'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { TransientToast, useTransientToast } from '../../../components/TransientToast'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  BRIDGE_IMAGE_OPERATIONS,
  type BridgeImageOperation
} from '../../../mobile-web-shell/bridge/bridge-image-verbs'
import { useImageActions } from '../../../platform/image-actions/image-actions'
import { ImageActionRefusedError } from '../../../platform/image-actions/image-actions-contract'
import { colors, feedback } from '../../../theme/mobile-theme'
import type { ImageViewerActionsProps } from './MobileNativeChatImageViewer'

type OperationCopy = {
  icon: LucideIcon
  label: string
  done: string | null
  failed: string
  // Save and Share raise system UI, which must wait for the sheet to leave.
  closeBeforePress: boolean
}

function operationCopy(t: Translate): Record<BridgeImageOperation, OperationCopy> {
  return {
    copy: {
      icon: Copy,
      label: t('chat.nativeChatImageViewer.copyImage', 'Copy image'),
      done: t('chat.nativeChatImageViewer.imageCopied', 'Image copied'),
      failed: t('chat.nativeChatImageViewer.copyFailed', "Couldn't copy image"),
      closeBeforePress: false
    },
    save: {
      icon: Download,
      label: t('chat.nativeChatImageViewer.saveImage', 'Save image'),
      done: t('chat.nativeChatImageViewer.imageSaved', 'Image saved'),
      failed: t('chat.nativeChatImageViewer.saveFailed', "Couldn't save image"),
      closeBeforePress: true
    },
    share: {
      icon: Share,
      label: t('chat.nativeChatImageViewer.share', 'Share…'),
      done: null,
      failed: t('chat.nativeChatImageViewer.shareFailed', "Couldn't share image"),
      closeBeforePress: true
    }
  }
}

function refusalMessage(t: Translate, error: ImageActionRefusedError): string {
  return error.reason === 'photos-access-denied'
    ? t('chat.nativeChatImageViewer.photosAccessDenied', 'Allow Orca to add photos in Settings')
    : t('chat.nativeChatImageViewer.imageTooLarge', 'This image is too large')
}

/** The viewer's Share button and sheet: copy, save to the photo library, or the system share sheet. Absent on shells without native.image.act and for images the phone cannot act on. */
export function MobileImageViewerActions({
  uri,
  buttonStyle,
  toastInset
}: ImageViewerActionsProps): React.JSX.Element | null {
  const t = useMobileTranslation()
  const actionsFor = useImageActions()
  const act = useMemo(() => actionsFor?.(uri) ?? null, [actionsFor, uri])
  const [menuOpen, setMenuOpen] = useState(false)
  const { message, showToast } = useTransientToast()
  if (!act) {
    return null
  }
  const operations = operationCopy(t)
  const run = (operation: BridgeImageOperation) => {
    const { done, failed } = operations[operation]
    act(operation).then(
      () => done && showToast(done),
      (error: unknown) =>
        showToast(error instanceof ImageActionRefusedError ? refusalMessage(t, error) : failed)
    )
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
        actions={BRIDGE_IMAGE_OPERATIONS.map((operation) => ({
          id: operation,
          label: operations[operation].label,
          icon: operations[operation].icon,
          closeBeforePress: operations[operation].closeBeforePress,
          onPress: () => run(operation)
        }))}
      />
      <TransientToast message={message} bottomInset={toastInset} />
    </>
  )
}
