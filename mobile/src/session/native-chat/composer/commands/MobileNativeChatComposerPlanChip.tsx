import { useState, type RefObject } from 'react'
import type { TextInputInstance } from 'react-native'
import { PencilRuler } from 'lucide-react-native'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import type { MobileNativeChatSessionOptionsController } from '../../input/session-options/use-mobile-native-chat-session-options'
import { MobileNativeChatComposerModeChip } from './MobileNativeChatComposerModeChip'

export function MobileNativeChatComposerPlanChip({
  options,
  inputRef
}: {
  options?: { controller: MobileNativeChatSessionOptionsController } | null
  inputRef: RefObject<TextInputInstance | null>
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  const [pending, setPending] = useState(false)
  const controller = options?.controller
  const descriptor = controller?.snapshot.find((entry) => entry.id === 'interactionMode')
  if (
    !controller ||
    descriptor?.kind.type !== 'select' ||
    descriptor.kind.currentValue !== 'plan'
  ) {
    return null
  }
  return (
    <MobileNativeChatComposerModeChip
      icon={PencilRuler}
      label={t('components.native-chat.composer.planMode', 'Plan')}
      exitLabel={t('components.native-chat.composer.exitPlanMode', 'Exit plan mode')}
      testID="native-chat-plan-chip"
      disabled={!descriptor.settable || pending}
      onExit={() => {
        setPending(true)
        void controller.setOption('interactionMode', 'default').finally(() => setPending(false))
        inputRef.current?.focus()
      }}
    />
  )
}
