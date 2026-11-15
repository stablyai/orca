import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useFocusEffect, useNavigation } from 'expo-router'
import type {
  BridgeAddContextChoice,
  BridgeAddContextOptions
} from '../bridge/native-capabilities/bridge-add-context-verbs'
import { BridgeNativeVerbRefusedError } from '../host-bridge/bridge-host-errors'
import type { AddContextPresenter } from '../../platform/media-picking/native-recent-photos'
import { useMediaPicker } from '../../platform/media-picking/media-picker'
import { MobileNativeChatAddContextSheet } from '../../session/native-chat/composer/attachments/MobileNativeChatAddContextSheet'
import { mobileNativeChatAttachActions } from '../../session/native-chat/composer/attachments/mobile-native-chat-attach-actions'

type Pending = {
  readonly options: BridgeAddContextOptions
  readonly settle: (choice: BridgeAddContextChoice, ids?: readonly string[]) => void
}

// The shell draws Add context over the page, so recent photos are seen and chosen here and only the tapped ones are staged.
export function useNativeAddContextSheet(sessionId: string | null): {
  present: AddContextPresenter
  sheet: ReactNode
} {
  const navigation = useNavigation()
  const library = useMediaPicker().recentPhotos
  const [pending, setPending] = useState<Pending | null>(null)
  const [visible, setVisible] = useState(false)
  const pendingRef = useRef<Pending | null>(null)

  const present = useCallback<AddContextPresenter>(
    (options) => {
      if (!navigation.isFocused() || pendingRef.current) {
        return Promise.reject(
          new BridgeNativeVerbRefusedError(
            'native_verb_failed',
            'the Add context sheet is already open or the page is not on screen'
          )
        )
      }
      return new Promise((resolve) => {
        const next: Pending = {
          options,
          settle: (choice, ids = []) => {
            if (pendingRef.current !== next) {
              return
            }
            pendingRef.current = null
            resolve({ choice, ids })
          }
        }
        pendingRef.current = next
        setPending(next)
        setVisible(true)
      })
    },
    [navigation]
  )

  // A replaced page or a screen pushed over it closes the sheet without a choice.
  const dismiss = useCallback(() => {
    pendingRef.current?.settle('dismissed')
    setVisible(false)
  }, [])
  useEffect(() => dismiss, [dismiss, sessionId])
  useFocusEffect(useCallback(() => dismiss, [dismiss]))

  const options = pending?.options
  const settle = (choice: BridgeAddContextChoice) => () => pending?.settle(choice)
  const sheet = pending ? (
    <MobileNativeChatAddContextSheet
      visible={visible}
      onClose={() => setVisible(false)}
      onAfterClose={() => {
        pending.settle('dismissed')
        // A request presented after this sheet unmounted must keep its own sheet.
        setPending((current) => (current === pending ? null : current))
      }}
      library={options?.images ? library : null}
      onPhotos={options?.images ? settle('photos') : undefined}
      onCamera={options?.images ? settle('camera') : undefined}
      onRecentPhotos={options?.images ? (ids) => pending.settle('recent', ids) : undefined}
      actions={mobileNativeChatAttachActions({
        onFiles: options?.files ? settle('files') : undefined,
        structured: options?.structured === true,
        onWorkspaceFile: settle('workspaceFile'),
        onSkills: settle('skills'),
        onCommands: settle('commands'),
        skillCount: options?.skillCount ?? 0
      })}
    />
  ) : null

  return { present, sheet }
}
