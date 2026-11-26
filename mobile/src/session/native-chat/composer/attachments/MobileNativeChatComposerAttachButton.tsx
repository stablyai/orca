import { useState } from 'react'
import { ActivityIndicator, Pressable } from 'react-native'
import { Plus } from 'lucide-react-native'
import { colors } from '../../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { ActionSheetModal } from '../../../../components/sheets/ActionSheetModal'
import { mobileNativeChatAttachActions } from './mobile-native-chat-attach-actions'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../../components/composer-input/composer-input-styles'

/** The composer's + button: the add-to-message sheet in a structured chat, else the photo library. */
export function MobileNativeChatComposerAttachButton({
  onAttachImage,
  onAttachFiles,
  structured,
  isAttaching,
  disabled,
  menu
}: {
  onAttachImage: (() => void) | undefined
  onAttachFiles: (() => void) | undefined
  structured: boolean
  isAttaching: boolean
  disabled: boolean
  /** A structured chat's add-to-message sheet; without it the button opens the photo library. */
  menu?: {
    openFileMenu: () => void
    openSlashMenu: (kind: 'skill' | 'command') => void
    skillCount: number
  }
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const [attachOpen, setAttachOpen] = useState(false)
  // A terminal-backed chat has only photos to add, so its + opens the library at once.
  const sheet = structured ? menu : undefined
  const attachPress = sheet ? () => setAttachOpen(true) : onAttachImage
  if (!attachPress) {
    return null
  }
  return (
    <>
      <Pressable
        accessibilityLabel={
          sheet
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
      {sheet ? (
        <ActionSheetModal
          visible={attachOpen}
          onClose={() => setAttachOpen(false)}
          actions={mobileNativeChatAttachActions({
            onPhotos: onAttachImage,
            onFiles: onAttachFiles,
            onWorkspaceFile: sheet.openFileMenu,
            onSkills: () => sheet.openSlashMenu('skill'),
            onCommands: () => sheet.openSlashMenu('command'),
            skillCount: sheet.skillCount
          })}
        />
      ) : null}
    </>
  )
}
