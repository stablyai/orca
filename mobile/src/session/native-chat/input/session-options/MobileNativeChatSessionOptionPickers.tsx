import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Keyboard, Platform, Text, View } from 'react-native'
import { ChevronLeft, Clock, LockKeyhole, PencilRuler } from 'lucide-react-native'
import { BottomDrawer } from '../../../../components/bottom-drawer/BottomDrawer'
import { ListGroup, LIST_LEADING_INSET, SectionHeader } from '../../../../components/list/ListGroup'
import { NavBarButton } from '../../../../components/nav-bar/NavBarButton'
import { SheetHeader } from '../../../../components/nav-bar/SheetHeader'
import { colors } from '../../../../theme/mobile-theme'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { useMoreModelsShown } from './use-more-models-shown'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionValue
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionValuesLabel,
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import {
  mobileDeferredPermissionSummary,
  mobileSessionOptionSummaryValue
} from './mobile-native-chat-session-option-labels'
import {
  descriptorRowElements,
  ModelPill,
  SessionOptionCaption,
  SessionOptionSummaryRows
} from './MobileNativeChatSessionOptionRows'
import {
  SessionOptionSegments,
  showsSessionOptionAsSegments
} from './MobileNativeChatSessionOptionSegments'
import { findAgentSessionInteractionMode } from '../../../../../../src/shared/agent-session/options/permissions/agent-session-interaction-mode'
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
  // Mid-turn terminal model commands would interleave with agent output.
  isWorking: boolean
  // Block applies during composer send: the host’s body/Enter delay could submit the setting as prompt text.
  sendInFlight?: boolean
}

type PresentationProps = {
  presentation: MobileNativeChatPickerPresentation | null
  onNavigate: (page: string | null) => void
  onDrawerOpen: (page: string) => void
  onModePressIn?: () => void
  onDrawerAfterClose?: () => void
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
  onModePressIn,
  onDrawerAfterClose
}: MobileNativeChatSessionOptionPickersProps & PresentationProps): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const interactionMode = findAgentSessionInteractionMode(controller.snapshot)
  const [modeChangeFailed, setModeChangeFailed] = useState(false)
  const modeView = presentation?.page === 'interactionMode'
  const modelSettingsOpen = presentation?.page != null && !modeView
  const wasOpen = useRef(false)
  useEffect(() => {
    if (modelSettingsOpen && !wasOpen.current) {
      controller.optionSurface?.demandModelCatalog?.()
    }
    wasOpen.current = modelSettingsOpen
  }, [modelSettingsOpen, controller.optionSurface])
  const { pendingId } = controller
  const snapshot = controller.snapshot.filter((descriptor) => descriptor.id !== 'interactionMode')
  const hasControls = snapshot.some((descriptor) => descriptor.settable)
  const canOpen = !sendInFlight && pendingId === null && hasControls
  useEffect(() => {
    if (modelSettingsOpen && !hasControls) {
      onNavigate(null)
    }
  }, [modelSettingsOpen, hasControls, onNavigate])
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const moreModels = useMoreModelsShown(model)
  const permission = snapshot.find(
    (descriptor) => descriptor.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  )
  const activeDescriptor = modeView
    ? (interactionMode ?? undefined)
    : hasControls
      ? snapshot.find((descriptor) => descriptor.id === presentation?.page)
      : undefined
  const permissionView = activeDescriptor !== undefined && activeDescriptor === permission
  const showWorkingNotice =
    (model !== undefined || permission !== undefined) &&
    activeDescriptor !== undefined &&
    isWorking &&
    activeDescriptor.transport !== 'agent-session' &&
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
  const home = model ?? permission ?? options[0]
  if (!home && !interactionMode) {
    return null
  }
  const modeChoice = selectedChoice(interactionMode ?? undefined)
  const modeLabel =
    interactionMode && modeChoice
      ? nativeChatSessionChoiceLabel(modeChoice, say, interactionMode.id)
      : say('buildMode')
  const homeView = activeDescriptor !== undefined && activeDescriptor === home
  const busy = pendingId !== null || sendInFlight
  // Structured picks and permission mode affect the next send, not the running turn.
  const locked = (descriptor: SessionOptionDescriptor): boolean =>
    busy || (isWorking && descriptor.transport !== 'agent-session' && descriptor !== permission)
  const reason = nativeChatSessionOptionDisabledReason(activeDescriptor?.disabledReason, say)
  const permissionChoice = selectedChoice(permission)
  const permissionColor = permissionChoiceColor(permissionChoice?.value)
  const permissionIcon =
    !model && permissionChoice ? permissionModeIcon(permissionChoice.value) : undefined
  const segmentOptions = options.filter(showsSessionOptionAsSegments)
  const rowOptions = options.filter((descriptor) => !segmentOptions.includes(descriptor))
  const primary = model
    ? nativeChatModelPillLabel(model, say)
    : home
      ? mobileSessionOptionSummaryValue(home)
      : ''
  const permissionDeferred = permission ? mobileDeferredPermissionSummary(permission)?.full : null
  const secondary = (model && nativeChatOptionValuesLabel(options, say)) || null
  // The model pill shows permission only as a warning tint, so its name carries a deferred pick.
  const modelValue = [primary, secondary, model && permissionDeferred].filter(Boolean).join(' ')

  const closePicker = (): void => onNavigate(null)
  const applyOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    if (descriptor === interactionMode && interactionMode.kind.currentValue === value) {
      closePicker()
      return
    }
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
      onNavigate(descriptor === home ? null : (home?.id ?? null))
    }
    void controller.setOption(descriptor.id, value).then((applied) => {
      if (descriptor === interactionMode) {
        setModeChangeFailed(!applied)
        if (applied) {
          closePicker()
        }
      } else if (applied && home && descriptor !== home && descriptor !== permission) {
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
    <>
      {home ? (
        <View style={styles.pillSlot}>
          <ModelPill
            primary={primary}
            secondary={secondary}
            warning={permissionColor !== undefined}
            icon={permissionIcon}
            leading={controller.heldPick ? Clock : undefined}
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
                  : t('chat.sessionOptionPickers.modelLabel', 'Model, {{value}}', {
                      value: modelValue
                    })
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
        </View>
      ) : null}
      {interactionMode ? (
        <ModelPill
          primary={modeLabel}
          secondary={null}
          warning={false}
          leading={PencilRuler}
          accessibleName={t(
            'components.native-chat.composer.pillAccessibleName',
            '{{value0}} {{value1}}',
            {
              value0: say('interactionMode'),
              value1: modeLabel
            }
          )}
          disabled={busy || !interactionMode.settable}
          onPressIn={onModePressIn}
          onPress={() => {
            setModeChangeFailed(false)
            onDrawerOpen(interactionMode.id)
            Keyboard.dismiss()
          }}
        />
      ) : null}
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
              {!modeView && !homeView && home ? (
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
              ) : null}
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
            {homeView && model ? (
              <SectionHeader title={nativeChatSessionOptionLabel(model, say)} first />
            ) : (
              <View style={styles.pageTop} />
            )}
            <ListGroup separatorInset={permissionView ? LIST_LEADING_INSET : undefined}>
              {descriptorRowElements(
                {
                  descriptor: activeDescriptor,
                  disabled: locked(activeDescriptor),
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
            {permissionView && permissionDeferred ? (
              <SessionOptionCaption>{permissionDeferred}</SessionOptionCaption>
            ) : null}
            {modeView && modeChangeFailed && pendingId === null ? (
              <View accessibilityLiveRegion="polite">
                <SessionOptionCaption>
                  {t('chat.sessionOptionPickers.modeUpdateFailed', 'Could not change mode.')}
                </SessionOptionCaption>
              </View>
            ) : null}
            {reason ? <SessionOptionCaption>{reason}</SessionOptionCaption> : null}
            {homeView && model ? (
              <>
                {segmentOptions.map((descriptor) => (
                  <SessionOptionSegments
                    key={descriptor.id}
                    descriptor={descriptor}
                    disabled={locked(descriptor)}
                    onSetOption={(value) => applyOption(descriptor, value)}
                  />
                ))}
                <SessionOptionSummaryRows
                  descriptors={[...rowOptions, ...(permission ? [permission] : [])]}
                  permission={permission}
                  permissionColor={permissionColor}
                  locked={locked}
                  onNavigate={onNavigate}
                  onSetOption={applyOption}
                />
              </>
            ) : null}
          </View>
        ) : null}
      </BottomDrawer>
    </>
  )
}
