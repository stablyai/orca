import type { ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent
} from 'react-native'
import { ImagePlus, Mic } from 'lucide-react-native'
import { pressTransition } from '../components/ui/transition-styles'
import { colors, MIN_TOUCH_TARGET, motion } from '../theme/mobile-theme'
import { keepHeldPressThroughLongPress } from './held-press-long-press'

type DictationState = {
  readonly isStarting: boolean
  readonly isRecording: boolean
  readonly isProcessing: boolean
}

type MobileTerminalInputActionsProps = {
  readonly canSend: boolean
  readonly isAttaching: boolean
  readonly dictation: DictationState
  readonly dictationMode: string | undefined
  readonly dictationEnabled?: boolean
  readonly onAttachImage: () => void
  readonly onAttachFile: () => void
  readonly onDictationToggle: () => void
  readonly onDictationPressIn: () => void
  readonly onDictationPressOut: () => void
  readonly onDictationCancel: () => void
}

// Image + mic peer actions shared by the live and buffered input bars so both
// surfaces offer identical multimodal entry points (and the JSX lives once).
export function MobileTerminalInputActions({
  canSend,
  isAttaching,
  dictation,
  dictationMode,
  dictationEnabled = true,
  onAttachImage,
  onAttachFile,
  onDictationToggle,
  onDictationPressIn,
  onDictationPressOut,
  onDictationCancel
}: MobileTerminalInputActionsProps) {
  const dictationActive = dictation.isStarting || dictation.isRecording
  return (
    <>
      <MobileTerminalInputRoundButton
        disabled={!canSend || isAttaching}
        // Tap opens the photo library; long-press picks a file. Uploads via host
        // RPC so SSH/remote sessions attach the same as local ones.
        onPress={onAttachImage}
        onLongPress={onAttachFile}
        delayLongPress={350}
        accessibilityLabel={isAttaching ? 'Sending image' : 'Attach a photo'}
        accessibilityHint="Long press to attach a file instead"
      >
        {isAttaching ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <ImagePlus size={18} color={colors.textSecondary} strokeWidth={2.2} />
        )}
      </MobileTerminalInputRoundButton>
      {dictationEnabled ? (
        <MobileTerminalInputRoundButton
          active={dictationActive}
          disabled={!canSend}
          onPress={dictationMode === 'toggle' ? onDictationToggle : undefined}
          onPressIn={dictationMode === 'hold' ? onDictationPressIn : undefined}
          onPressOut={dictationMode === 'hold' ? onDictationPressOut : undefined}
          onLongPress={
            dictationMode === 'toggle'
              ? () => {
                  if (dictation.isRecording || dictation.isProcessing) {
                    onDictationCancel()
                  }
                }
              : keepHeldPressThroughLongPress
          }
          accessibilityLabel={
            dictation.isRecording
              ? 'Stop voice dictation'
              : dictation.isProcessing
                ? 'Cancel voice dictation'
                : dictation.isStarting
                  ? 'Starting voice dictation'
                  : 'Start voice dictation'
          }
        >
          {dictation.isProcessing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Mic
              size={18}
              color={dictationActive ? colors.textPrimary : colors.textSecondary}
              strokeWidth={2.2}
            />
          )}
        </MobileTerminalInputRoundButton>
      ) : null}
    </>
  )
}

const CIRCLE = 32

/** A 32 pt circle inside the input box; its 44 pt touch box overhangs the box's padding. */
export function MobileTerminalInputRoundButton({
  children,
  active = false,
  ready = false,
  soft = false,
  disabled = false,
  onPress,
  onPressIn,
  onPressOut,
  onLongPress,
  delayLongPress,
  accessibilityLabel,
  accessibilityHint
}: {
  children: ReactNode
  /** Recording: a soft fill with a brighter edge. */
  active?: boolean
  /** The send with something to send: the screen's one filled circle. */
  ready?: boolean
  /** A resting fill, for the send while there is nothing typed. */
  soft?: boolean
  disabled?: boolean
  onPress?: () => void
  onPressIn?: () => void
  onPressOut?: () => void
  onLongPress?: (event: GestureResponderEvent) => void
  delayLongPress?: number
  accessibilityLabel: string
  accessibilityHint?: string
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={[styles.touch, disabled && styles.disabled]}
    >
      {({ pressed }) => (
        <View
          style={[
            styles.circle,
            ready ? styles.ready : active ? styles.active : soft ? styles.soft : null,
            pressed && (ready ? styles.readyPressed : styles.pressed),
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          {children}
        </View>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  touch: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    marginVertical: -6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  disabled: { opacity: motion.disabledOpacity },
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center'
  },
  active: { backgroundColor: colors.fillPressed, borderColor: colors.fieldBorderFocused },
  ready: { backgroundColor: colors.primary },
  soft: { backgroundColor: colors.fill },
  pressed: { backgroundColor: colors.fillPressed, transform: [{ scale: motion.pressedIconScale }] },
  readyPressed: {
    backgroundColor: colors.primaryPressed,
    transform: [{ scale: motion.pressedIconScale }]
  }
})
