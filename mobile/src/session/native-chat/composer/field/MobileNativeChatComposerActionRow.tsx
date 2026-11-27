import { useState, type ComponentProps, type ReactNode } from 'react'
import { View } from 'react-native'
import { spacing } from '../../../../theme/mobile-theme'
import { useThemedStyles } from '../../../../theme/themed-styles'
import {
  COMPOSER_CONTROL_SIZE,
  composerInputStylesSheet
} from '../../../../components/composer-input/composer-input-styles'
import { mobileNativeChatComposerStylesSheet } from './mobile-native-chat-composer-styles'
import { MobileNativeChatDictationLeading } from '../dictation/MobileNativeChatDictationLeading'
import { MobileNativeChatComposerModeRow } from './MobileNativeChatComposerModeRow'

export function MobileNativeChatComposerActionRow({
  collapsed,
  hasAttachment,
  modeRow,
  children,
  ...dictation
}: Omit<ComponentProps<typeof MobileNativeChatDictationLeading>, 'children' | 'unwrapped'> & {
  collapsed: boolean
  hasAttachment: boolean
  modeRow: Omit<
    ComponentProps<typeof MobileNativeChatComposerModeRow>,
    'collapsed' | 'modelOnOwnRow' | 'hasPicker' | 'hasExtras' | 'extrasMaxWidth' | 'onExtrasWidth'
  >
  children: ReactNode
}): React.JSX.Element {
  const styles = useThemedStyles(mobileNativeChatComposerStylesSheet)
  const inputStyles = useThemedStyles(composerInputStylesSheet)
  const [width, setWidth] = useState<number>()
  const [trailingWidth, setTrailingWidth] = useState(COMPOSER_CONTROL_SIZE)
  const [extrasWidth, setExtrasWidth] = useState(0)
  const snapshot = modeRow.sessionOptions?.controller.snapshot
  const hasPicker = !collapsed && snapshot?.some(({ id }) => id !== 'interactionMode') === true
  const hasExtras =
    !collapsed &&
    Boolean(
      modeRow.roomReplies ||
      modeRow.goalChip ||
      snapshot?.some(
        ({ id, kind }) =>
          id === 'interactionMode' && kind.type === 'select' && kind.currentValue === 'plan'
      )
    )
  const controlsWidth = (hasAttachment ? COMPOSER_CONTROL_SIZE + spacing.sm : 0) + trailingWidth
  // Reserve room for the warning icon, chevron, and a readable model prefix.
  const minWidth =
    controlsWidth +
    spacing.sm +
    3 * COMPOSER_CONTROL_SIZE +
    (hasExtras ? extrasWidth + spacing.sm : 0)
  const modelOnOwnRow = hasPicker && width !== undefined && width < minWidth
  // Cap the chip group the same way in both layouts so wrapping can't change the threshold calculation.
  const extrasMaxWidth =
    hasPicker && width !== undefined ? Math.max(0, width - controlsWidth - spacing.sm) : undefined

  return (
    <View
      style={[
        inputStyles.actionRow,
        collapsed && styles.pillActionRow,
        modelOnOwnRow && styles.wrappedActionRow
      ]}
      onLayout={hasPicker ? (event) => setWidth(event.nativeEvent.layout.width) : undefined}
      testID="native-chat-composer-actions"
    >
      <MobileNativeChatDictationLeading {...dictation} unwrapped>
        <MobileNativeChatComposerModeRow
          {...modeRow}
          {...{ collapsed, modelOnOwnRow, hasPicker, hasExtras, extrasMaxWidth }}
          onExtrasWidth={hasPicker ? setExtrasWidth : undefined}
        />
      </MobileNativeChatDictationLeading>
      <View
        style={styles.actionRowTrailing}
        onLayout={
          hasPicker ? (event) => setTrailingWidth(event.nativeEvent.layout.width) : undefined
        }
      >
        {children}
      </View>
    </View>
  )
}
