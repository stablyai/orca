import { useEffect, useState } from 'react'
import { AccessibilityInfo, Keyboard, Platform } from 'react-native'
import { PencilRuler } from 'lucide-react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { findAgentSessionInteractionMode } from '../../../../../../src/shared/agent-session/options/permissions/agent-session-interaction-mode'
import type { SessionOptionValue } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { nativeChatSessionChoiceLabel } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { ModelPill } from './MobileNativeChatSessionOptionRows'
import { mobileNativeChatSessionOptionSay } from './native-chat-session-option-copy'
import type { MobileNativeChatPickerPresentation } from './MobileNativeChatSessionOptionPickers'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'

type InteractionMode = NonNullable<ReturnType<typeof findAgentSessionInteractionMode>>

export function useMobileNativeChatInteractionMode(
  controller: MobileNativeChatSessionOptionsController,
  presentation: MobileNativeChatPickerPresentation | null,
  onClose: (expected: MobileNativeChatPickerPresentation) => void
) {
  const t = useMobileTranslation()
  const descriptor = findAgentSessionInteractionMode(controller.snapshot)
  const [failedPage, setFailedPage] = useState<MobileNativeChatPickerPresentation | null>(null)
  const error =
    descriptor &&
    presentation?.page === descriptor.id &&
    failedPage === presentation &&
    controller.pendingId === null
      ? t('chat.sessionOptionPickers.modeUpdateFailed', 'Could not change mode.')
      : null
  useEffect(() => {
    if (Platform.OS === 'ios' && error) {
      AccessibilityInfo.announceForAccessibilityWithOptions(error, { queue: false })
    }
  }, [error])

  function select(value: SessionOptionValue): void {
    if (!descriptor || !presentation) {
      return
    }
    if (descriptor.kind.currentValue === value) {
      onClose(presentation)
      return
    }
    setFailedPage(null)
    void controller.setOption(descriptor.id, value).then((applied) => {
      if (applied) {
        onClose(presentation)
      } else {
        setFailedPage(presentation)
      }
    })
  }

  return { descriptor, error, select }
}

export function MobileNativeChatInteractionModePill({
  descriptor,
  busy,
  onOpen
}: {
  descriptor: InteractionMode
  busy: boolean
  onOpen: (page: string) => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const say = mobileNativeChatSessionOptionSay(t)
  const choice = descriptor.kind.choices.find(({ value }) => value === descriptor.kind.currentValue)
  const label = choice ? nativeChatSessionChoiceLabel(choice, say, descriptor.id) : say('buildMode')
  return (
    <ModelPill
      primary={label}
      warning={false}
      leading={PencilRuler}
      accessibleName={t(
        'components.native-chat.composer.pillAccessibleName',
        '{{interactionMode}} {{selectedMode}}',
        { interactionMode: say('interactionMode'), selectedMode: label }
      )}
      disabled={busy || !descriptor.settable}
      onPress={() => {
        onOpen(descriptor.id)
        Keyboard.dismiss()
      }}
    />
  )
}
