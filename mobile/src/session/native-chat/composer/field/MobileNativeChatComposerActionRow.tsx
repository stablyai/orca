import { useState, type ComponentProps, type ReactNode } from 'react'
import { View } from 'react-native'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { spacing } from '../../../../theme/mobile-theme'
import {
  COMPOSER_CONTROL_SIZE,
  composerInputStyles as inputStyles
} from '../../../../components/composer-input/composer-input-styles'
import {
  COMPOSER_ATTACH_AND_MODEL_MIN_WIDTH,
  mobileNativeChatComposerStyles as styles
} from './mobile-native-chat-composer-styles'
import { MobileNativeChatDictationLeading } from '../dictation/MobileNativeChatDictationLeading'

export function MobileNativeChatComposerActionRow({
  hasMic,
  optionSnapshot,
  leadingExtras,
  children,
  ...leading
}: Omit<ComponentProps<typeof MobileNativeChatDictationLeading>, 'modelOnOwnRow'> & {
  hasMic: boolean
  optionSnapshot?: readonly SessionOptionDescriptor[]
  leadingExtras: ReactNode
}): React.JSX.Element {
  const [width, setWidth] = useState<number>()
  const trailingControls = 1 + Number(!!leading.trailing) + Number(hasMic)
  const minWidth =
    COMPOSER_ATTACH_AND_MODEL_MIN_WIDTH + trailingControls * (COMPOSER_CONTROL_SIZE + spacing.sm)
  const hasModelPicker = optionSnapshot?.some(({ id }) => id !== 'interactionMode') ?? false
  const modelOnOwnRow = hasModelPicker && width !== undefined && width < minWidth

  return (
    <View
      style={[inputStyles.actionRow, modelOnOwnRow && styles.wrappedActionRow]}
      onLayout={hasModelPicker ? (event) => setWidth(event.nativeEvent.layout.width) : undefined}
      testID="native-chat-composer-actions"
    >
      <MobileNativeChatDictationLeading {...leading} modelOnOwnRow={modelOnOwnRow}>
        {leadingExtras}
      </MobileNativeChatDictationLeading>
      {children}
    </View>
  )
}
