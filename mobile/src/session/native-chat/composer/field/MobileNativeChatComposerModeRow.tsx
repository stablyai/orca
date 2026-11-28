import type { ReactNode, RefObject } from 'react'
import { View, type TextInputInstance } from 'react-native'
import Animated from 'react-native-reanimated'
import { useKeyboardPersistingTaps } from '../../../../platform/keyboard/keyboard-persisting-taps'
import {
  MobileNativeChatSessionOptionPickers,
  type MobileNativeChatSessionOptionPickersProps
} from '../../input/session-options/MobileNativeChatSessionOptionPickers'
import type { useMobileNativeChatPickerPresentation } from '../../input/session-options/use-mobile-native-chat-picker-presentation'
import { MobileNativeChatComposerPlanChip } from '../commands/MobileNativeChatComposerPlanChip'
import type { MobileNativeChatContext } from '../commands/MobileNativeChatContextUsage'
import { mobileNativeChatComposerStylesSheet as stylesSheet } from './mobile-native-chat-composer-styles'
import { useThemedStyles } from '../../../../theme/themed-styles'

/** The full composer's model pill and mode chips after +, which the idle pill leaves out. */
export function MobileNativeChatComposerModeRow({
  fade,
  roomReplies,
  sessionOptions,
  title,
  context,
  sendInFlight,
  picker: [picker, setPicker],
  focused,
  fieldRef,
  goalChip
}: {
  fade: object | null
  roomReplies: ReactNode
  sessionOptions: MobileNativeChatSessionOptionPickersProps | null | undefined
  title: string | undefined
  context: MobileNativeChatContext
  sendInFlight: boolean
  picker: ReturnType<typeof useMobileNativeChatPickerPresentation>
  focused: boolean
  fieldRef: RefObject<TextInputInstance | null>
  goalChip: ReactNode
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  // A tap on the model pill or a chip keeps the field focused, so the box never folds under the finger.
  const keepsFocus = useKeyboardPersistingTaps('handled')
  // A request the sheet can't show (nothing it lists is settable) never opens it, so nothing would clear it.
  const hasControls =
    sessionOptions?.controller.snapshot.some(
      (entry) => entry.id !== 'interactionMode' && entry.settable
    ) === true
  return (
    <Animated.View style={[styles.leadingExtras, fade]}>
      <View ref={keepsFocus} style={styles.leadingExtrasRow}>
        {roomReplies}
        {sessionOptions ? (
          <MobileNativeChatSessionOptionPickers
            {...sessionOptions}
            title={title}
            context={context}
            sendInFlight={sendInFlight}
            presentation={picker}
            // A pick that lands after Done must not reopen the closing sheet.
            onNavigate={(page) =>
              setPicker((current) =>
                page === null && !hasControls
                  ? null
                  : current?.page == null
                    ? current
                    : { ...current, page }
              )
            }
            onDrawerOpen={(page) => setPicker({ page, refocus: focused })}
            onDrawerAfterClose={() => {
              if (picker?.refocus) {
                fieldRef.current?.focus()
              }
              setPicker(null)
            }}
          />
        ) : null}
        <MobileNativeChatComposerPlanChip options={sessionOptions} inputRef={fieldRef} />
        {goalChip}
      </View>
    </Animated.View>
  )
}
