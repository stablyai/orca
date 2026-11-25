import { useState } from 'react'
import { ActivityIndicator, Pressable } from 'react-native'
import { Plus } from 'lucide-react-native'
import { colors } from '../../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { ActionSheetModal } from '../../../../components/sheets/ActionSheetModal'
import {
  mobileNativeChatAttachActions,
  mobileNativeChatMediaAttachActions
} from './mobile-native-chat-attach-actions'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../../components/composer-input/composer-input-styles'

/** The composer's + button: opens a sheet to choose what to attach; a terminal-backed chat offers photos and files, a structured chat adds workspace files, skills and commands. */
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
  // Photos only is a single choice, so the + opens the library at once; any second choice gets the sheet.
  const sheet = structured ? menu : undefined
  const hasChoice =
    sheet !== undefined || (onAttachImage !== undefined && onAttachFiles !== undefined)
  const attachPress = hasChoice ? () => setAttachOpen(true) : onAttachImage
  if (!attachPress) {
    return null
  }
  return (
    <>
      <Pressable
        accessibilityLabel={
          hasChoice
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
      {hasChoice ? (
        <ActionSheetModal
          visible={attachOpen}
          onClose={() => setAttachOpen(false)}
          actions={
            sheet
              ? mobileNativeChatAttachActions({
                  onPhotos: onAttachImage,
                  onFiles: onAttachFiles,
                  onWorkspaceFile: sheet.openFileMenu,
                  onSkills: () => sheet.openSlashMenu('skill'),
                  onCommands: () => sheet.openSlashMenu('command'),
                  skillCount: sheet.skillCount
                })
              : mobileNativeChatMediaAttachActions({
                  onPhotos: onAttachImage,
                  onFiles: onAttachFiles
                })
          }
        />
      ) : null}
    </>
  )
}
