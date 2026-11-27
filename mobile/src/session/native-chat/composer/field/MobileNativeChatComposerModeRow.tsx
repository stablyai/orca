import { Fragment, type ReactNode, type RefObject } from 'react'
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
  attachment,
  collapsed,
  modelOnOwnRow,
  hasPicker,
  hasExtras,
  extrasMaxWidth,
  onExtrasWidth,
  agent,
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
  attachment: ReactNode
  collapsed: boolean
  modelOnOwnRow: boolean
  hasPicker: boolean
  hasExtras: boolean
  extrasMaxWidth?: number
  onExtrasWidth?: (width: number) => void
  agent: string | null
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
  const keepsModelFocus = useKeyboardPersistingTaps('handled')
  const keepsExtrasFocus = useKeyboardPersistingTaps('handled')
  // A request the sheet can't show (nothing it lists is settable) never opens it, so nothing would clear it.
  const hasControls =
    sessionOptions?.controller.snapshot.some(
      (entry) => entry.id !== 'interactionMode' && entry.settable
    ) === true

  const attach = <Fragment key="attach">{attachment}</Fragment>
  const model =
    !collapsed && sessionOptions ? (
      <Animated.View
        key="model"
        style={[
          styles.modelSlot,
          modelOnOwnRow && styles.fullWidthModelSlot,
          fade,
          !hasPicker && styles.emptyModelSlot
        ]}
      >
        <View ref={keepsModelFocus}>
          <MobileNativeChatSessionOptionPickers
            {...sessionOptions}
            agent={agent}
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
        </View>
      </Animated.View>
    ) : null
  const extras = hasExtras ? (
    <Animated.View
      key="extras"
      style={[
        styles.leadingExtras,
        hasPicker && styles.pickerExtras,
        { maxWidth: extrasMaxWidth },
        fade
      ]}
      onLayout={
        onExtrasWidth ? (event) => onExtrasWidth(event.nativeEvent.layout.width) : undefined
      }
    >
      <View ref={keepsExtrasFocus} style={styles.leadingExtrasRow}>
        {roomReplies}
        <MobileNativeChatComposerPlanChip options={sessionOptions} inputRef={fieldRef} />
        {goalChip}
      </View>
    </Animated.View>
  ) : null
  // Keep the open picker and attachment sheet mounted when the pane crosses the wrap threshold.
  return <>{modelOnOwnRow ? [model, attach, extras] : [attach, model, extras]}</>
}
