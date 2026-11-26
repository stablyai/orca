import { useEffect, useRef } from 'react'
import { AccessibilityInfo, Keyboard, Platform, Text, View } from 'react-native'
import { Clock, LockKeyhole } from 'lucide-react-native'
import { BottomDrawer } from '../../../../components/bottom-drawer/BottomDrawer'
import { ListGroup, LIST_LEADING_INSET, SectionHeader } from '../../../../components/list/ListGroup'
import { SheetHeader } from '../../../../components/nav-bar/SheetHeader'
import { MobileAgentIcon } from '../../../../components/icons/MobileAgentIcon'
import { useMobileChatModelChoices } from '../../../../bots/use-bot-model-choices'
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
  SessionOptionSummaryRow,
  SessionOptionSummaryRows
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
import { MobileChatProviderChoices } from './MobileChatProviderChoices'
import type { MobileChatProviderPickerScope } from './use-mobile-chat-provider-picker'
import { tuiAgentDisplayName } from '../../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'

export type MobileNativeChatPickerPresentation = { page: string | null; refocus: boolean }

export type MobileNativeChatSessionOptionPickersProps = {
  controller: MobileNativeChatSessionOptionsController
  providerPicker?: MobileChatProviderPickerScope | null
  activeAgent?: string | null
  // Mid-turn terminal model commands would interleave with agent output.
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

function selectedChoice(descriptor: SessionOptionDescriptor | undefined) {
  return descriptor?.kind.type === 'select'
    ? descriptor.kind.choices.find((choice) => choice.value === descriptor.kind.currentValue)
    : undefined
}

export function MobileNativeChatSessionOptionPickers({
  controller,
  providerPicker,
  activeAgent,
  isWorking,
  sendInFlight = false,
  presentation,
  onNavigate,
  onDrawerOpen,
  onDrawerAfterClose
}: MobileNativeChatSessionOptionPickersProps & PresentationProps): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const selection = providerPicker?.selection
  const providerPage = !!providerPicker && presentation?.page === 'agent'
  const open = presentation?.page != null
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current && !selection) {
      controller.optionSurface?.demandModelCatalog?.()
    }
    wasOpen.current = open
  }, [open, controller.optionSurface, selection])
  const catalog = useMobileChatModelChoices(
    providerPicker?.client ?? null,
    providerPage && providerPicker?.client.getState() === 'connected',
    selection?.agent,
    providerPicker?.worktreeId ?? '',
    { model: selection?.options?.model, options: selection?.options }
  )
  const { pendingId } = controller
  const snapshot = controller.snapshot.filter((descriptor) => descriptor.id !== 'interactionMode')
  const hasControls = snapshot.some((descriptor) => descriptor.settable)
  const canOpen = !sendInFlight && pendingId === null && (hasControls || !!providerPicker)
  useEffect(() => {
    if (open && !hasControls && !providerPicker) {
      onNavigate(null)
    }
  }, [open, hasControls, providerPicker, onNavigate])
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const moreModels = useMoreModelsShown(model)
  const permission = snapshot.find(
    (descriptor) => descriptor.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  )
  const options = sortNativeChatSessionOptions(snapshot)
  const home = model ?? permission ?? options[0]
  const rootPage = providerPicker ? 'agent' : (home?.id ?? null)
  const activeDescriptor = hasControls
    ? providerPage
      ? selection
        ? undefined
        : home
      : snapshot.find((descriptor) => descriptor.id === presentation?.page)
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

  if (!model && !permission && options.length === 0 && !providerPicker) {
    return null
  }
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
  const pickedAgent = providerPicker ? (selection?.agent ?? activeAgent) : null
  const pickedAgentName = pickedAgent ? (tuiAgentDisplayName(pickedAgent) ?? pickedAgent) : null
  const permissionDeferred = permission ? mobileDeferredPermissionSummary(permission)?.full : null
  const secondary = (model && nativeChatOptionValuesLabel(options, say)) || null
  const providerDetails = (
    selection
      ? [
          catalog?.model?.label ?? selection.options?.model ?? catalog?.modelId,
          catalog?.effort?.option.kind.choices.find(
            (choice) => choice.value === catalog.effort?.value
          )?.label ?? selection.options?.effort
        ]
      : [primary, secondary]
  )
    .filter(Boolean)
    .join(' · ')
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
      (descriptor.fallbackModel ?? descriptor.kind.currentValue) === value
    ) {
      return
    }
    // Close permission selection immediately because its write may wait behind agent startup.
    if (descriptor === permission) {
      onNavigate(!providerPicker && descriptor === home ? null : rootPage)
    }
    void controller.setOption(descriptor.id, value).then((applied) => {
      if (applied && descriptor !== home && descriptor !== permission) {
        onNavigate(rootPage)
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
  const descriptorRows = activeDescriptor ? (
    <>
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
          {t('chat.sessionOptionPickers.dispatchUnconfirmed', 'Sent to the agent — not confirmed')}
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
    </>
  ) : null

  return (
    <View style={styles.pillSlot}>
      <ModelPill
        primary={pickedAgentName ?? primary}
        secondary={pickedAgentName ? providerDetails || null : secondary}
        leadingContent={
          pickedAgent ? <MobileAgentIcon agentId={pickedAgent} size={15} /> : undefined
        }
        warning={permissionColor !== undefined}
        icon={providerPicker ? undefined : permissionIcon}
        leading={controller.heldPick ? Clock : undefined}
        accessibleName={
          pickedAgentName
            ? [pickedAgentName, providerDetails].filter(Boolean).join(', ')
            : model
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
          if (rootPage) {
            onDrawerOpen(rootPage)
          }
          Keyboard.dismiss()
        }}
      />
      <BottomDrawer
        visible={activeDescriptor !== undefined || providerPage}
        onClose={closePicker}
        onAfterClose={() => {
          moreModels.reset()
          onDrawerAfterClose?.()
        }}
      >
        {providerPage || activeDescriptor ? (
          <View style={styles.sheet}>
            <View style={styles.header}>
              <SheetHeader
                title={
                  providerPage || !activeDescriptor
                    ? t('chat.providerSwitch.agent', 'Agent')
                    : nativeChatSessionOptionLabel(activeDescriptor, say)
                }
                subtitle={
                  pendingId !== null
                    ? t('chat.sessionOptionPickers.applying', 'Applying…')
                    : controller.appliesOnAttach
                      ? t('chat.sessionOptionPickers.onAttach', 'Applies when the chat attaches')
                      : undefined
                }
                {...(providerPage || (!providerPicker && homeView)
                  ? {}
                  : {
                      onBack: {
                        label: t('chat.sessionOptionPickers.backToModels', 'Back to models'),
                        onPress: () => onNavigate(rootPage)
                      }
                    })}
                trailing={{ label: t('common.done', 'Done'), onPress: closePicker }}
              />
            </View>
            {providerPage && providerPicker && activeAgent ? (
              <MobileChatProviderChoices
                scope={providerPicker}
                active={activeAgent}
                catalog={catalog}
              >
                {selection && permission ? (
                  <ListGroup>
                    <SessionOptionSummaryRow
                      label={t(
                        'chat.providerSwitch.currentPermissions',
                        'Current agent permissions'
                      )}
                      value={permissionChoice?.label ?? ''}
                      disabled={busy}
                      onPress={() => onNavigate(permission.id)}
                    />
                  </ListGroup>
                ) : (
                  descriptorRows
                )}
              </MobileChatProviderChoices>
            ) : (
              descriptorRows
            )}
          </View>
        ) : null}
      </BottomDrawer>
    </View>
  )
}
