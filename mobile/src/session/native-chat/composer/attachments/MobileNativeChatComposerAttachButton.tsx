import { useState } from 'react'
import { ActivityIndicator, Pressable } from 'react-native'
import { Plus } from 'lucide-react-native'
import { colors } from '../../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { ActionSheetModal } from '../../../../components/sheets/ActionSheetModal'
import { mobileNativeChatAttachActions } from './mobile-native-chat-attach-actions'
import type { MobilePickedFileSource } from '../../../../platform/media-picking/media-picker-contract'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../../components/composer-input/composer-input-styles'

/** The composer's + button: the add-to-message sheet, or the photo library when photos are all it can add. */
export function MobileNativeChatComposerAttachButton({
  onAttachImage,
  onAttachFiles,
  structured,
  isAttaching,
  disabled,
  menu
}: {
  onAttachImage: (() => void) | undefined
  onAttachFiles: ((from: MobilePickedFileSource) => void) | undefined
  structured: boolean
  isAttaching: boolean
  disabled: boolean
  /** A structured chat's workspace rows; without them the sheet offers photos, files and videos. */
  menu?: {
    openFileMenu: () => void
    openSlashMenu: (kind: 'skill' | 'command') => void
    skillCount: number
  }
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const [attachOpen, setAttachOpen] = useState(false)
  const sheet = structured ? menu : undefined
  // With only photos to add, the + opens the library at once.
  const opensSheet = sheet !== undefined || onAttachFiles !== undefined
  const attachPress = opensSheet ? () => setAttachOpen(true) : onAttachImage
  if (!attachPress) {
    return null
  }
  return (
    <>
      <Pressable
        accessibilityLabel={
          opensSheet
            ? t('chat.composer.addToMessage', 'Add to message')
            : t('chat.composer.attachImage', 'Attach image')
        }
        style={({ pressed }) => [inputStyles.controlButton, pressed && inputStyles.pressed]}
        onPress={attachPress}
        disabled={isAttaching || disabled}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      >
        {isAttaching ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Plus size={19} color={colors.textPrimary} strokeWidth={2} />
        )}
      </Pressable>
      {opensSheet ? (
        <ActionSheetModal
          visible={attachOpen}
          onClose={() => setAttachOpen(false)}
          actions={mobileNativeChatAttachActions({
            onPhotos: onAttachImage,
            onFiles: onAttachFiles && (() => onAttachFiles('files')),
            onVideos: onAttachFiles && (() => onAttachFiles('videos')),
            structured: sheet !== undefined,
            onWorkspaceFile: () => sheet?.openFileMenu(),
            onSkills: () => sheet?.openSlashMenu('skill'),
            onCommands: () => sheet?.openSlashMenu('command'),
            skillCount: sheet?.skillCount ?? 0
          })}
        />
      ) : null}
    </>
  )
}
