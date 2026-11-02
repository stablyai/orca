import { ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronLeft, X } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  isReadOnlySessionOptionValue,
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import {
  mobileModelPillLabel,
  mobileOptionsPillLabel,
  mobileSessionOptionSummaryValue,
  mobileSessionOptionDisabledReason
} from './mobile-native-chat-session-option-labels'
import {
  DescriptorRows,
  Pill,
  SessionOptionCaption,
  SessionOptionSummaryRow
} from './MobileNativeChatSessionOptionRows'
import { sortNativeChatSessionOptions } from '../../../src/shared/native-chat-session-option-snapshot'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../src/shared/agent-chat-permission-mode'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'

export type MobileNativeChatPickerPresentation = { page: string | null; refocus: boolean }

export type MobileNativeChatSessionOptionPickersProps = {
  controller: MobileNativeChatSessionOptionsController
  /** Pickers lock while the agent works — a mid-turn `/model` interleaves with
   *  the agent's own output (desktop parity). */
  isWorking: boolean
  /** A composer send owns the TUI input line until it settles. The host spaces a
   *  send's body and its Enter ~500ms apart, so an apply dispatched inside that
   *  window would be submitted as part of the user's prompt. The composer blocks
   *  the reverse direction on `pendingId`; this is the same guard mirrored. */
  sendInFlight?: boolean
  /** The collapsed composer hides the pills but keeps the drawer mounted. */
  pillsHidden?: boolean
}

type PresentationProps = {
  presentation: MobileNativeChatPickerPresentation | null
  onNavigate: (page: string | null) => void
  /** A pill opened the drawer; fires before the keyboard is dismissed. */
  onDrawerOpen: (page: string) => void
  /** The drawer's sheet has fully left the screen, however it closed. */
  onDrawerAfterClose?: () => void
}

/** Full access reads in the warning colour wherever it is shown. */
function permissionChoiceColor(value: string | undefined): string | undefined {
  return value === 'full-access' ? colors.statusAmber : undefined
}

/** The permission pill, then the combined model/session-option pill, sharing one bottom drawer. */
export function MobileNativeChatSessionOptionPickers({
  controller,
  isWorking,
  sendInFlight = false,
  pillsHidden = false,
  presentation,
  onNavigate,
  onDrawerOpen,
  onDrawerAfterClose
}: MobileNativeChatSessionOptionPickersProps & PresentationProps): React.JSX.Element | null {
  const { snapshot, pendingId } = controller
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const permission = snapshot.find(
    (descriptor) => descriptor.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  )
  const options = sortNativeChatSessionOptions(snapshot)
  if (!model && !permission) {
    return null
  }
  const activeDescriptor = snapshot.find((descriptor) => descriptor.id === presentation?.page)
  const permissionView = activeDescriptor !== undefined && activeDescriptor === permission
  // The permission mode applies from the next send, so a running turn never locks it.
  const disabled = (!permissionView && isWorking) || pendingId !== null || sendInFlight
  const modelView = model !== undefined && activeDescriptor?.id === model.id
  const modelLabel = model ? mobileModelPillLabel(model) : ''
  const optionsLabel = options.length > 0 ? mobileOptionsPillLabel(options) : null
  const pillLabel = optionsLabel ? `${modelLabel} ${optionsLabel}` : modelLabel
  const reason = mobileSessionOptionDisabledReason(activeDescriptor?.disabledReason)

  const closePicker = (): void => onNavigate(null)
  const openPicker = (page: string): void => {
    onDrawerOpen(page)
    Keyboard.dismiss()
  }

  const applyOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    // Re-picking the tracked value is a no-op — never re-dispatch it.
    if (
      descriptor.valueSource !== 'unknown' &&
      descriptor.kind.type === 'select' &&
      descriptor.kind.currentValue === value
    ) {
      closePicker()
      return
    }
    // A permission pick shows at once; its write may wait behind a starting agent.
    if (descriptor === permission) {
      closePicker()
    }
    void controller.setOption(descriptor.id, value).then((applied) => {
      if (applied) {
        closePicker()
      }
    })
  }
  const invokeAction = (descriptor: SessionOptionDescriptor): void => {
    void controller.invokeAction(descriptor.id).then((invoked) => {
      if (invoked) {
        closePicker()
      }
    })
  }

  const permissionChoice =
    permission?.kind.type === 'select'
      ? permission.kind.choices.find((choice) => choice.value === permission.kind.currentValue)
      : undefined
  const pillsBusy = pendingId !== null || sendInFlight

  return (
    // One tree in both modes: re-parenting the drawer would remount an open sheet.
    <View style={pillsHidden ? styles.pillsHidden : styles.pills}>
      {!pillsHidden && permission && permissionChoice ? (
        <Pill
          label={permissionChoice.label}
          accessibleName={`Permissions, ${permissionChoice.label}`}
          disabled={pillsBusy}
          labelColor={permissionChoiceColor(permissionChoice.value)}
          onPress={() => openPicker(permission.id)}
        />
      ) : null}
      {model && !pillsHidden ? (
        <Pill
          label={pillLabel}
          accessibleName={`Model, ${pillLabel}`}
          disabled={isWorking || pillsBusy}
          onPress={() => openPicker(model.id)}
        />
      ) : null}
      <BottomDrawer
        visible={activeDescriptor !== undefined}
        onClose={closePicker}
        onAfterClose={onDrawerAfterClose}
      >
        {activeDescriptor ? (
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Pressable
                accessibilityLabel={modelView || permissionView ? 'Close picker' : 'Back to models'}
                accessibilityRole="button"
                style={({ pressed }) => [styles.sheetNav, pressed && styles.pressed]}
                onPress={
                  modelView || permissionView ? closePicker : () => onNavigate(model?.id ?? null)
                }
                hitSlop={8}
              >
                {modelView || permissionView ? (
                  <X size={18} color={colors.textSecondary} strokeWidth={2.2} />
                ) : (
                  <ChevronLeft size={18} color={colors.textSecondary} strokeWidth={2.2} />
                )}
              </Pressable>
              <Text style={styles.sheetTitle}>
                {modelView ? 'Select model' : `Select ${activeDescriptor.label.toLowerCase()}`}
              </Text>
              <View style={styles.sheetHeaderSide}>
                {pendingId !== null ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : null}
              </View>
            </View>
            {sessionOptionDispatchUnconfirmed(activeDescriptor) ? (
              <SessionOptionCaption>Sent to the agent — not confirmed</SessionOptionCaption>
            ) : null}
            {reason ? <SessionOptionCaption>{reason}</SessionOptionCaption> : null}
            <View style={styles.choiceGroup}>
              <DescriptorRows
                descriptor={activeDescriptor}
                disabled={disabled}
                grouped
                onSetOption={(value) => applyOption(activeDescriptor, value)}
                onInvokeAction={() => invokeAction(activeDescriptor)}
                {...(permissionView ? { choiceLabelColor: permissionChoiceColor } : {})}
              />
            </View>
            {modelView && options.length > 0 ? (
              <View style={styles.optionGroup}>
                {options.map((descriptor, index) => (
                  <SessionOptionSummaryRow
                    key={descriptor.id}
                    label={descriptor.label}
                    value={mobileSessionOptionSummaryValue(descriptor)}
                    disabled={disabled}
                    divided={index < options.length - 1}
                    onPress={
                      isReadOnlySessionOptionValue(descriptor)
                        ? undefined
                        : () => onNavigate(descriptor.id)
                    }
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </BottomDrawer>
    </View>
  )
}

const styles = StyleSheet.create({
  // The composer row's only shrinkable item: a long label truncates before it pushes Send off.
  pills: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
    gap: spacing.xs
  },
  // Out of the row's flow, so the collapsed composer spends no gap on an empty slot.
  pillsHidden: {
    position: 'absolute'
  },
  sheet: {
    paddingBottom: spacing.xs
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: spacing.lg
  },
  sheetTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '700',
    textAlign: 'center'
  },
  sheetNav: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  sheetHeaderSide: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  choiceGroup: {
    overflow: 'hidden',
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  optionGroup: {
    overflow: 'hidden',
    marginTop: spacing.md,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  pressed: {
    opacity: 0.7
  }
})
