import { useEffect, useRef } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  Text,
  View
} from 'react-native'
import {
  ChevronLeft,
  FilePenLine,
  Hand,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  X,
  type LucideIcon
} from 'lucide-react-native'
import { BottomDrawer } from '../../../components/BottomDrawer'
import { colors } from '../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import {
  isReadOnlySessionOptionValue,
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionValuesLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from '../../../../../src/shared/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import { mobileSessionOptionSummaryValue } from './mobile-native-chat-session-option-labels'
import {
  DescriptorRows,
  ModelPill,
  SessionOptionCaption,
  SessionOptionSummaryRow
} from './MobileNativeChatSessionOptionRows'
import {
  SessionOptionSegments,
  showsSessionOptionAsSegments
} from './MobileNativeChatSessionOptionSegments'
import { sortNativeChatSessionOptions } from '../../../../../src/shared/native-chat/input/native-chat-session-option-snapshot'
import {
  AGENT_CHAT_PERMISSION_MODE_ICON_NAMES,
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode
} from '../../../../../src/shared/agent-chat-permission-mode'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import { sessionOptionPickerStyles as styles } from './mobile-native-chat-session-option-picker-styles'

export type MobileNativeChatPickerPresentation = { page: string | null; refocus: boolean }

export type MobileNativeChatSessionOptionPickersProps = {
  controller: MobileNativeChatSessionOptionsController
  // Mid-turn model commands would interleave with agent output.
  isWorking: boolean
  // Block applies during composer send: the host’s body/Enter delay could submit the setting as prompt text.
  sendInFlight?: boolean
}

type PresentationProps = {
  presentation: MobileNativeChatPickerPresentation | null
  onNavigate: (page: string | null) => void
  onDrawerOpen: (page: string) => void
  onDrawerAfterClose?: () => void
}

function permissionChoiceColor(value: string | undefined): string | undefined {
  return value === 'full-access' ? colors.statusAmber : undefined
}

function permissionModeIcon(value: string): LucideIcon | undefined {
  if (!isAgentChatPermissionMode(value)) {
    return undefined
  }
  switch (AGENT_CHAT_PERMISSION_MODE_ICON_NAMES[value]) {
    case 'Hand':
      return Hand
    case 'FilePenLine':
      return FilePenLine
    case 'ShieldCheck':
      return ShieldCheck
    case 'ShieldAlert':
      return ShieldAlert
  }
}

function selectedChoice(descriptor: SessionOptionDescriptor | undefined) {
  return descriptor?.kind.type === 'select'
    ? descriptor.kind.choices.find((choice) => choice.value === descriptor.kind.currentValue)
    : undefined
}

export function MobileNativeChatSessionOptionPickers({
  controller,
  isWorking,
  sendInFlight = false,
  presentation,
  onNavigate,
  onDrawerOpen,
  onDrawerAfterClose
}: MobileNativeChatSessionOptionPickersProps & PresentationProps): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const open = presentation?.page != null
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      controller.optionSurface?.demandModelCatalog?.()
    }
    wasOpen.current = open
  }, [open, controller.optionSurface])
  const { snapshot, pendingId } = controller
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const permission = snapshot.find(
    (descriptor) => descriptor.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  )
  const activeDescriptor = snapshot.find((descriptor) => descriptor.id === presentation?.page)
  const permissionView = activeDescriptor !== undefined && activeDescriptor === permission
  const showWorkingNotice =
    (model !== undefined || permission !== undefined) &&
    activeDescriptor !== undefined &&
    isWorking &&
    !permissionView

  useEffect(() => {
    if (Platform.OS === 'ios' && showWorkingNotice) {
      // Queued announcements cannot be canceled when the picker closes or changes pages.
      AccessibilityInfo.announceForAccessibilityWithOptions(
        translate(
          'chat.sessionOptionPickers.workingAnnouncement',
          'Agent is working. Model settings unlock when this turn finishes.'
        ),
        { queue: false }
      )
    }
  }, [showWorkingNotice])

  const options = sortNativeChatSessionOptions(snapshot)
  if (!model && !permission) {
    return null
  }
  const home = model ?? permission!
  const homeView = activeDescriptor !== undefined && activeDescriptor === home
  const busy = pendingId !== null || sendInFlight
  // Permission mode affects the next send, so a working turn must not lock it.
  const locked = isWorking || busy
  const reason = nativeChatSessionOptionDisabledReason(activeDescriptor?.disabledReason, say)
  const permissionChoice = selectedChoice(permission)
  const permissionColor = permissionChoiceColor(permissionChoice?.value)
  const permissionIcon =
    !model && permissionChoice ? permissionModeIcon(permissionChoice.value) : undefined
  const segmentOptions = options.filter(showsSessionOptionAsSegments)
  const rowOptions = options.filter((descriptor) => !segmentOptions.includes(descriptor))
  const primary = model
    ? nativeChatModelPillLabel(model, say)
    : mobileSessionOptionSummaryValue(home)
  const secondary = (model && nativeChatOptionValuesLabel(options, say)) || null

  const closePicker = (): void => onNavigate(null)
  const applyOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    // A permission report can match a new explicit pick while the saved intent is Own.
    if (
      descriptor !== permission &&
      descriptor.valueSource !== 'unknown' &&
      descriptor.kind.type === 'select' &&
      descriptor.kind.currentValue === value
    ) {
      return
    }
    // Close permission selection immediately because its write may wait behind agent startup.
    if (descriptor === permission) {
      onNavigate(descriptor === home ? null : home.id)
    }
    void controller.setOption(descriptor.id, value).then((applied) => {
      if (applied && descriptor !== home && descriptor !== permission) {
        onNavigate(home.id)
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

  return (
    <View style={styles.pillSlot}>
      <ModelPill
        primary={primary}
        secondary={secondary}
        warning={permissionColor !== undefined}
        icon={permissionIcon}
        accessibleName={
          model
            ? permissionColor
              ? t(
                  'chat.sessionOptionPickers.modelFullAccessLabel',
                  'Model, {{value}}, full access',
                  {
                    value: secondary ? `${primary} ${secondary}` : primary
                  }
                )
              : t('chat.sessionOptionPickers.modelLabel', 'Model, {{value}}', {
                  value: secondary ? `${primary} ${secondary}` : primary
                })
            : t('chat.sessionOptionPickers.permissionsLabel', 'Permissions, {{value}}', {
                value: primary
              })
        }
        disabled={busy || (!model && permission?.settable === false)}
        onPress={() => {
          onDrawerOpen(home.id)
          Keyboard.dismiss()
        }}
      />
      <BottomDrawer
        visible={activeDescriptor !== undefined}
        onClose={closePicker}
        onAfterClose={onDrawerAfterClose}
      >
        {activeDescriptor ? (
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Pressable
                accessibilityLabel={
                  homeView
                    ? t('chat.sessionOptionPickers.closePicker', 'Close picker')
                    : t('chat.sessionOptionPickers.backToModels', 'Back to models')
                }
                accessibilityRole="button"
                style={({ pressed }) => [styles.sheetNav, pressed && styles.pressed]}
                onPress={homeView ? closePicker : () => onNavigate(home.id)}
                hitSlop={8}
              >
                {homeView ? (
                  <X size={18} color={colors.textSecondary} strokeWidth={2.2} />
                ) : (
                  <ChevronLeft size={18} color={colors.textSecondary} strokeWidth={2.2} />
                )}
              </Pressable>
              <Text style={styles.sheetTitle}>
                {nativeChatSessionOptionLabel(activeDescriptor, say)}
              </Text>
              <View style={styles.sheetHeaderSide}>
                {pendingId !== null ? (
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                ) : null}
              </View>
            </View>
            {showWorkingNotice ? (
              <View style={styles.lockNotice} accessibilityLiveRegion="polite">
                <LockKeyhole size={16} color={colors.textSecondary} />
                <View style={styles.lockNoticeBody}>
                  <Text style={styles.lockNoticeTitle}>
                    {t('chat.sessionOptionPickers.agentWorking', 'Agent is working')}
                  </Text>
                  <Text style={styles.lockNoticeDescription}>
                    {t(
                      'chat.sessionOptionPickers.settingsLocked',
                      'Model settings unlock when this turn finishes.'
                    )}
                  </Text>
                </View>
              </View>
            ) : null}
            {sessionOptionDispatchUnconfirmed(activeDescriptor) ? (
              <SessionOptionCaption>
                {t(
                  'chat.sessionOptionPickers.dispatchUnconfirmed',
                  'Sent to the agent — not confirmed'
                )}
              </SessionOptionCaption>
            ) : null}
            {reason ? <SessionOptionCaption>{reason}</SessionOptionCaption> : null}
            <View style={styles.group}>
              <DescriptorRows
                descriptor={activeDescriptor}
                disabled={permissionView ? busy : locked}
                grouped
                onSetOption={(value) => applyOption(activeDescriptor, value)}
                onInvokeAction={() => invokeAction(activeDescriptor)}
                {...(permissionView ? { choiceLabelColor: permissionChoiceColor } : {})}
              />
            </View>
            {homeView && model ? (
              <>
                {segmentOptions.map((descriptor) => (
                  <SessionOptionSegments
                    key={descriptor.id}
                    descriptor={descriptor}
                    disabled={locked}
                    onSetOption={(value) => applyOption(descriptor, value)}
                  />
                ))}
                <OptionRows
                  descriptors={[...rowOptions, ...(permission ? [permission] : [])]}
                  permission={permission}
                  permissionColor={permissionColor}
                  locked={locked}
                  busy={busy}
                  onNavigate={onNavigate}
                  onSetOption={applyOption}
                />
              </>
            ) : null}
          </View>
        ) : null}
      </BottomDrawer>
    </View>
  )
}

function OptionRows({
  descriptors,
  permission,
  permissionColor,
  locked,
  busy,
  onNavigate,
  onSetOption
}: {
  descriptors: readonly SessionOptionDescriptor[]
  permission: SessionOptionDescriptor | undefined
  permissionColor: string | undefined
  locked: boolean
  busy: boolean
  onNavigate: (page: string) => void
  onSetOption: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (descriptors.length === 0) {
    return null
  }
  return (
    <View style={[styles.group, styles.groupSpaced]}>
      {descriptors.map((descriptor, index) => {
        const isPermission = descriptor === permission
        const disabled = isPermission ? busy || !descriptor.settable : locked
        if (descriptor.kind.type === 'boolean' && !descriptor.action) {
          return (
            <View key={descriptor.id} style={index < descriptors.length - 1 && styles.divided}>
              <DescriptorRows
                descriptor={descriptor}
                disabled={disabled}
                grouped
                onSetOption={(value) => onSetOption(descriptor, value)}
                onInvokeAction={() => onNavigate(descriptor.id)}
              />
            </View>
          )
        }
        const value = mobileSessionOptionSummaryValue(descriptor)
        return (
          <SessionOptionSummaryRow
            key={descriptor.id}
            label={
              isPermission
                ? t('chat.sessionOptionPickers.permissions', 'Permissions')
                : nativeChatSessionOptionLabel(descriptor, say)
            }
            value={value}
            valueColor={isPermission ? permissionColor : undefined}
            disabled={disabled}
            divided={index < descriptors.length - 1}
            onPress={
              isReadOnlySessionOptionValue(descriptor) ? undefined : () => onNavigate(descriptor.id)
            }
          />
        )
      })}
    </View>
  )
}
