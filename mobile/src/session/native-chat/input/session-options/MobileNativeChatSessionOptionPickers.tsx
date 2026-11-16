import { useEffect, useRef } from 'react'
import { Keyboard, View } from 'react-native'
import { ChevronLeft, Clock } from 'lucide-react-native'
import { BottomDrawer } from '../../../../components/bottom-drawer/BottomDrawer'
import { ListGroup, LIST_LEADING_INSET, SectionHeader } from '../../../../components/list/ListGroup'
import { NavBarButton } from '../../../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../../../components/nav-bar/SheetHeader'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { useMoreModelsShown } from './use-more-models-shown'
import {
  isReadOnlySessionOptionValue,
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionValuesLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { hasNativeChatTurnOptionPick } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-turn-option-picks'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import {
  mobileDeferredPermissionSummary,
  mobileSessionOptionSummaryValue
} from './mobile-native-chat-session-option-labels'
import {
  descriptorRowElements,
  ModelPill,
  SessionOptionCaption,
  SessionOptionSummaryRow,
  showsSessionOptionAsSwitch
} from './MobileNativeChatSessionOptionRows'
import {
  SessionOptionSegments,
  showsSessionOptionAsSegments
} from './MobileNativeChatSessionOptionSegments'
import { sortNativeChatSessionOptions } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-snapshot'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../../../src/shared/agent-launch/permissions/agent-chat-permission-mode-option-id'
import {
  permissionChoiceColor,
  permissionChoiceLeading,
  permissionModeIcon
} from './mobile-native-chat-permission-mode-icons'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import { sessionOptionPickerStyles as styles } from './mobile-native-chat-session-option-picker-styles'

export type MobileNativeChatPickerPresentation = { page: string | null; refocus: boolean }

export type MobileNativeChatSessionOptionPickersProps = {
  controller: MobileNativeChatSessionOptionsController
  // Block applies during composer send: the host’s body/Enter delay could submit the setting as prompt text.
  sendInFlight?: boolean
}

type PresentationProps = {
  presentation: MobileNativeChatPickerPresentation | null
  onNavigate: (page: string | null) => void
  onDrawerOpen: (page: string) => void
  onDrawerAfterClose?: () => void
}

function selectedChoice(descriptor: SessionOptionDescriptor | undefined) {
  return descriptor?.kind.type === 'select'
    ? descriptor.kind.choices.find((choice) => choice.value === descriptor.kind.currentValue)
    : undefined
}

export function MobileNativeChatSessionOptionPickers({
  controller,
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
  const { pendingId } = controller
  const snapshot = controller.snapshot.filter((descriptor) => descriptor.id !== 'interactionMode')
  const hasControls = snapshot.some((descriptor) => descriptor.settable)
  const canOpen = !sendInFlight && pendingId === null && hasControls
  useEffect(() => {
    if (open && !hasControls) {
      onNavigate(null)
    }
  }, [open, hasControls, onNavigate])
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const moreModels = useMoreModelsShown(model)
  const permission = snapshot.find(
    (descriptor) => descriptor.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  )
  const activeDescriptor = hasControls
    ? snapshot.find((descriptor) => descriptor.id === presentation?.page)
    : undefined
  const permissionView = activeDescriptor !== undefined && activeDescriptor === permission
  const turnPick = hasNativeChatTurnOptionPick(snapshot)

  const options = sortNativeChatSessionOptions(snapshot)
  if (!model && !permission && options.length === 0) {
    return null
  }
  const home = model ?? permission ?? options[0]!
  const homeView = activeDescriptor !== undefined && activeDescriptor === home
  // Mid-turn picks wait for the turn to end, so only a write in flight locks the rows.
  const busy = pendingId !== null || sendInFlight
  const pageTurnPick = homeView ? turnPick : activeDescriptor?.appliesAfterTurn === true
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
  const permissionDeferred = permission ? mobileDeferredPermissionSummary(permission)?.full : null
  const secondary = (model && nativeChatOptionValuesLabel(options, say)) || null
  // The model pill shows permission only as a warning tint, so its name carries a deferred pick.
  const modelValue = [primary, secondary, model && permissionDeferred].filter(Boolean).join(' ')

  const closePicker = (): void => onNavigate(null)
  const applyOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    // A permission report can match a new explicit pick while the saved intent is Own.
    if (
      descriptor !== permission &&
      descriptor.valueSource !== 'unknown' &&
      descriptor.valueSource !== 'default' &&
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
        leading={controller.heldPick || turnPick ? Clock : undefined}
        accessibleName={
          model
            ? permissionColor && !permissionDeferred
              ? t(
                  'chat.sessionOptionPickers.modelFullAccessLabel',
                  'Model, {{value}}, full access',
                  {
                    value: modelValue
                  }
                )
              : t('chat.sessionOptionPickers.modelLabel', 'Model, {{value}}', { value: modelValue })
            : t('chat.sessionOptionPickers.permissionsLabel', 'Permissions, {{value}}', {
                value: permissionDeferred ?? primary
              })
        }
        disabled={!canOpen}
        onPress={() => {
          if (!canOpen) {
            return
          }
          onDrawerOpen(home.id)
          Keyboard.dismiss()
        }}
      />
      <BottomDrawer
        visible={activeDescriptor !== undefined}
        onClose={closePicker}
        onAfterClose={() => {
          moreModels.reset()
          onDrawerAfterClose?.()
        }}
      >
        {activeDescriptor ? (
          <View style={styles.sheet}>
            <View style={styles.header}>
              <SheetHeader
                title={nativeChatSessionOptionLabel(activeDescriptor, say)}
                subtitle={
                  pendingId !== null
                    ? t('chat.sessionOptionPickers.applying', 'Applying…')
                    : controller.appliesOnAttach
                      ? t('chat.sessionOptionPickers.onAttach', 'Applies when the chat attaches')
                      : undefined
                }
                trailing={{ label: t('common.done', 'Done'), onPress: closePicker }}
              />
              {homeView ? null : (
                <View style={styles.back}>
                  <NavBarButton
                    icon={ChevronLeft}
                    accessibilityLabel={t(
                      'chat.sessionOptionPickers.backToModels',
                      'Back to models'
                    )}
                    onPress={() => onNavigate(home.id)}
                  />
                </View>
              )}
            </View>
            {homeView && model ? (
              <SectionHeader title={nativeChatSessionOptionLabel(model, say)} first />
            ) : (
              <View style={styles.pageTop} />
            )}
            <ListGroup separatorInset={permissionView ? LIST_LEADING_INSET : undefined}>
              {descriptorRowElements(
                {
                  descriptor: activeDescriptor,
                  disabled: busy,
                  onSetOption: (value) => applyOption(activeDescriptor, value),
                  onInvokeAction: () => invokeAction(activeDescriptor),
                  moreChoices: moreModels,
                  ...(permissionView ? { choiceLeading: permissionChoiceLeading } : {})
                },
                t
              )}
            </ListGroup>
            {sessionOptionDispatchUnconfirmed(activeDescriptor) ? (
              <SessionOptionCaption>
                {t(
                  'chat.sessionOptionPickers.dispatchUnconfirmed',
                  'Sent to the agent — not confirmed'
                )}
              </SessionOptionCaption>
            ) : null}
            {pageTurnPick ? (
              <SessionOptionCaption>
                {t('chat.sessionOptionPickers.appliesAfterTurn', 'Applies when this turn finishes')}
              </SessionOptionCaption>
            ) : null}
            {permissionView && permissionDeferred ? (
              <SessionOptionCaption>{permissionDeferred}</SessionOptionCaption>
            ) : null}
            {reason ? <SessionOptionCaption>{reason}</SessionOptionCaption> : null}
            {homeView && model ? (
              <>
                {segmentOptions.map((descriptor) => (
                  <SessionOptionSegments
                    key={descriptor.id}
                    descriptor={descriptor}
                    disabled={busy}
                    onSetOption={(value) => applyOption(descriptor, value)}
                  />
                ))}
                <OptionRows
                  descriptors={[...rowOptions, ...(permission ? [permission] : [])]}
                  permission={permission}
                  permissionColor={permissionColor}
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
  busy,
  onNavigate,
  onSetOption
}: {
  descriptors: readonly SessionOptionDescriptor[]
  permission: SessionOptionDescriptor | undefined
  permissionColor: string | undefined
  busy: boolean
  onNavigate: (page: string) => void
  onSetOption: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void
}): React.JSX.Element | null {
  const t = useMobileTranslation()
  if (descriptors.length === 0) {
    return null
  }
  return (
    <>
      <SectionHeader title={t('chat.sessionOptionPickers.optionsSection', 'Options')} />
      <ListGroup>
        {descriptors.flatMap((descriptor) => {
          const isPermission = descriptor === permission
          const deferred = isPermission ? mobileDeferredPermissionSummary(descriptor) : null
          const disabled = busy || !descriptor.settable
          if (showsSessionOptionAsSwitch(descriptor)) {
            return descriptorRowElements(
              {
                descriptor,
                disabled,
                onSetOption: (value) => onSetOption(descriptor, value),
                onInvokeAction: () => onNavigate(descriptor.id)
              },
              t
            )
          }
          return [
            <SessionOptionSummaryRow
              key={descriptor.id}
              label={
                isPermission
                  ? t('chat.sessionOptionPickers.permissions', 'Permissions')
                  : nativeChatSessionOptionLabel(descriptor, say)
              }
              value={deferred?.saved ?? mobileSessionOptionSummaryValue(descriptor)}
              subtitle={deferred?.timing}
              accessibleValue={deferred?.full}
              valueColor={isPermission ? permissionColor : undefined}
              disabled={disabled}
              onPress={
                isReadOnlySessionOptionValue(descriptor)
                  ? undefined
                  : () => onNavigate(descriptor.id)
              }
            />
          ]
        })}
      </ListGroup>
    </>
  )
}
