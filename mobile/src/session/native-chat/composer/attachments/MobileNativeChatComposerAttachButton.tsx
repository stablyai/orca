import { useState } from 'react'
import { ActivityIndicator, Pressable } from 'react-native'
import { Plus } from 'lucide-react-native'
import { colors } from '../../../../theme/mobile-theme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { mobileNativeChatAttachActions } from './mobile-native-chat-attach-actions'
import { MobileNativeChatAddContextSheet } from './MobileNativeChatAddContextSheet'
import type {
  AddContextChoice,
  MobileComposerImagePick
} from '../../../../platform/media-picking/media-picker-contract'
import { useMediaPicker } from '../../../../platform/media-picking/media-picker'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../../components/composer-input/composer-input-styles'

/** The composer's + button: opens the Add context sheet (photos, camera, files and, in a structured chat, workspace context). */
export function MobileNativeChatComposerAttachButton({
  onAttachImages,
  onAttachFiles,
  structured,
  isAttaching,
  disabled,
  menu
}: {
  onAttachImages: ((pick: MobileComposerImagePick) => void) | undefined
  onAttachFiles: (() => void) | undefined
  structured: boolean
  isAttaching: boolean
  disabled: boolean
  menu: {
    openFileMenu: () => void
    openSlashMenu: (kind: 'skill' | 'command') => void
    skillCount: number
  }
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const picker = useMediaPicker()
  const [attachOpen, setAttachOpen] = useState(false)
  if (!structured && !onAttachImages) {
    return null
  }
  const run = (choice: AddContextChoice): void => {
    if (choice.choice === 'recent') {
      if (onAttachImages) {
        onAttachImages({ recentPhotos: choice.images, release: choice.release })
      } else {
        choice.release()
      }
    } else if (choice.choice === 'camera' || choice.choice === 'photos') {
      onAttachImages?.(choice.choice === 'camera' ? 'camera' : 'library')
    } else if (choice.choice === 'files') {
      onAttachFiles?.()
    } else if (choice.choice === 'workspaceFile') {
      menu.openFileMenu()
    } else if (choice.choice === 'skills' || choice.choice === 'commands') {
      menu.openSlashMenu(choice.choice === 'skills' ? 'skill' : 'command')
    }
  }
  // On the served page the shell draws the sheet, so the photo library never reaches the page.
  const { openAddContext, recentPhotos: library } = picker
  const open = openAddContext
    ? () => {
        const options = {
          images: onAttachImages !== undefined,
          files: onAttachFiles !== undefined,
          structured,
          skillCount: menu.skillCount
        }
        openAddContext(options).then(run, (error: unknown) => {
          console.warn('[add-context] the shell sheet failed; drawing it in the page', error)
          setAttachOpen(true)
        })
      }
    : () => setAttachOpen(true)
  return (
    <>
      <Pressable
        accessibilityLabel={t('chat.composer.addToMessage', 'Add to message')}
        style={({ pressed }) => [inputStyles.controlButton, pressed && inputStyles.pressed]}
        onPress={open}
        disabled={isAttaching || disabled}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      >
        {isAttaching ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Plus size={19} color={colors.textPrimary} strokeWidth={2} />
        )}
      </Pressable>
      <MobileNativeChatAddContextSheet
        visible={attachOpen}
        onClose={() => setAttachOpen(false)}
        onPhotos={onAttachImages && (() => onAttachImages('library'))}
        onCamera={onAttachImages && (() => onAttachImages('camera'))}
        library={library}
        onRecentPhotos={
          onAttachImages && library
            ? (ids) => onAttachImages({ recentPhotos: library.pick(ids), release: () => {} })
            : undefined
        }
        actions={mobileNativeChatAttachActions({
          onFiles: onAttachFiles,
          structured,
          onWorkspaceFile: menu.openFileMenu,
          onSkills: () => menu.openSlashMenu('skill'),
          onCommands: () => menu.openSlashMenu('command'),
          skillCount: menu.skillCount
        })}
      />
    </>
  )
}
