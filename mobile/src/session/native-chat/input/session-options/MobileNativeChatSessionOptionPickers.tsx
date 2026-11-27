import { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Keyboard, Platform, View } from 'react-native'
import { Clock } from 'lucide-react-native'
import { BottomDrawer } from '../../../../components/bottom-drawer/BottomDrawer'
import { ListGroup, LIST_LEADING_INSET, SectionHeader } from '../../../../components/list/ListGroup'
import { SheetHeader } from '../../../../components/nav-bar/SheetHeader'
import { translate, type Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { useMoreModelsShown } from './use-more-models-shown'
import {
  MobileNativeChatModelSearchList,
  modelListNeedsSearch
} from './MobileNativeChatModelSearchList'
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
import { mobileNativeChatSessionOptionSay } from './native-chat-session-option-copy'
import {
  mobileDeferredPermissionSummary,
  mobileSessionOptionSummaryValue
} from './mobile-native-chat-session-option-labels'
import {
  descriptorRowElements,
  ModelPill,
  SessionOptionCaption,
  SessionOptionLockCaption,
  SessionOptionSummaryRow,
  showsSessionOptionAsSwitch
} from './MobileNativeChatSessionOptionRows'
import { sortNativeChatSessionOptions } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-snapshot'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../../../src/shared/agent-launch/permissions/agent-chat-permission-mode-option-id'
import {
  permissionChoiceColor,
  permissionChoiceLeading,
  permissionModeIcon
} from './mobile-native-chat-permission-mode-icons'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import { sessionOptionPickerStylesSheet as stylesSheet } from './mobile-native-chat-session-option-picker-styles'
import {
  MobileNativeChatContextSection,
  type MobileNativeChatContext
} from '../../composer/commands/MobileNativeChatContextUsage'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useThemedStyles } from '../../../../theme/themed-styles'

export type MobileNativeChatPickerPresentation = { page: string | null; refocus: boolean }

/** The sheet's first page: every option at a glance. Other pages are a descriptor's id. */
const SESSION_OPTIONS_HOME = '\u0000options'

export type MobileNativeChatSessionOptionPickersProps = {
  controller: MobileNativeChatSessionOptionsController
  // Mid-turn terminal model commands would interleave with agent output.
  isWorking: boolean
  // Block applies during composer send: the host’s body/Enter delay could submit the setting as prompt text.
  sendInFlight?: boolean
}

type PresentationProps = {
  /** The sheet's title: the agent's name. */
  title?: string
  context?: MobileNativeChatContext
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
  isWorking,
  sendInFlight = false,
  title,
  context,
  presentation,
  onNavigate,
  onDrawerOpen,
  onDrawerAfterClose
}: MobileNativeChatSessionOptionPickersProps & PresentationProps): React.JSX.Element | null {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const say = mobileNativeChatSessionOptionSay(t)
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
  const homeView = hasControls && presentation?.page === SESSION_OPTIONS_HOME
  const activeDescriptor = hasControls
    ? snapshot.find((descriptor) => descriptor.id === presentation?.page)
    : undefined
  const permissionView = activeDescriptor !== undefined && activeDescriptor === permission
  // Decided on arriving at a page and kept through the close, so a listing landing mid-visit never swaps the sheet's layout.
  const page = presentation?.page ?? null
  const [searchLayout, setSearchLayout] = useState<{ page: string | null; search: boolean }>({
    page: null,
    search: false
  })
  if (page !== null && page !== searchLayout.page && (homeView || activeDescriptor !== undefined)) {
    setSearchLayout({
      page,
      search:
        activeDescriptor !== undefined && activeDescriptor === model && modelListNeedsSearch(model)
    })
  }
  const searchSheet = searchLayout.search
  const modelSearchView =
    searchSheet && activeDescriptor !== undefined && activeDescriptor === model
  // Permission mode and structured picks apply to the next send, so only the rest lock mid-turn.
  const locksMidTurn = (descriptor: SessionOptionDescriptor | undefined): boolean =>
    descriptor !== undefined &&
    descriptor !== permission &&
    descriptor.transport !== 'agent-session'
  const options = sortNativeChatSessionOptions(snapshot).filter(
    (descriptor) => descriptor !== model && descriptor !== permission
  )
  const homeRows = [...(model ? [model] : []), ...options]
  const showWorkingNotice =
    isWorking && (homeView ? homeRows.some(locksMidTurn) : locksMidTurn(activeDescriptor))

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

  if (!model && !permission && options.length === 0) {
    return null
  }
  const busy = pendingId !== null || sendInFlight
  const locked = (descriptor: SessionOptionDescriptor): boolean =>
    busy || (isWorking && locksMidTurn(descriptor))
  const reason = nativeChatSessionOptionDisabledReason(activeDescriptor?.disabledReason, say)
  const permissionChoice = selectedChoice(permission)
  const permissionColor = permissionChoiceColor(colors, permissionChoice?.value)
  const permissionIcon =
    !model && permissionChoice ? permissionModeIcon(permissionChoice.value) : undefined
  const primary = model
    ? nativeChatModelPillLabel(model, say)
    : mobileSessionOptionSummaryValue((permission ?? options[0])!, t)
  const permissionDeferred = permission
    ? mobileDeferredPermissionSummary(permission, t)?.full
    : null
  const secondary = (model && nativeChatOptionValuesLabel(options, say)) || null
  // The pill shows only the model; its spoken name still carries effort and a deferred pick.
  const modelValue = [primary, secondary, model && permissionDeferred].filter(Boolean).join(' ')

  const closePicker = (): void => onNavigate(null)
  const goHome = (): void => onNavigate(SESSION_OPTIONS_HOME)
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
    // Permission's write may wait behind agent startup, so its own page returns home at once.
    if (descriptor === permission && permissionView) {
      goHome()
    }
    void controller.setOption(descriptor.id, value).then((applied) => {
      if (applied && descriptor !== permission) {
        goHome()
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
  const compact = context?.onCompact

  return (
    <View style={styles.pillSlot}>
      <ModelPill
        primary={primary}
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
          onDrawerOpen(SESSION_OPTIONS_HOME)
          Keyboard.dismiss()
        }}
      />
      <BottomDrawer
        visible={homeView || activeDescriptor !== undefined}
        // Each page opens at its top, not at the last page's scroll.
        scrollResetKey={presentation?.page ?? null}
        // A searchable list holds its own scroll and keeps a fixed height, so the keyboard and filtering never resize it.
        fillAvailable={searchSheet}
        contentScrollable={!searchSheet}
        onClose={closePicker}
        onAfterClose={() => {
          moreModels.reset()
          setSearchLayout({ page: null, search: false })
          onDrawerAfterClose?.()
        }}
      >
        {homeView || activeDescriptor ? (
          <View style={[styles.sheet, searchSheet && styles.sheetFill]}>
            <View style={styles.header}>
              <SheetHeader
                title={
                  activeDescriptor
                    ? nativeChatSessionOptionLabel(activeDescriptor, say)
                    : (title ?? t('chat.sessionOptionPickers.title', 'Chat options'))
                }
                subtitle={
                  pendingId !== null
                    ? t('chat.sessionOptionPickers.applying', 'Applying…')
                    : controller.appliesOnAttach
                      ? t('chat.sessionOptionPickers.onAttach', 'Applies when the chat attaches')
                      : undefined
                }
                {...(activeDescriptor
                  ? { onBack: { label: t('common.back', 'Back'), onPress: goHome } }
                  : {})}
                trailing={{ label: t('common.done', 'Done'), onPress: closePicker }}
              />
            </View>
            <View style={styles.pageTop} />
            {activeDescriptor ? (
              <>
                {modelSearchView ? (
                  <MobileNativeChatModelSearchList
                    model={activeDescriptor}
                    disabled={locked(activeDescriptor)}
                    moreChoices={moreModels}
                    onSetOption={(value) => applyOption(activeDescriptor, value)}
                  />
                ) : (
                  <ListGroup separatorInset={permissionView ? LIST_LEADING_INSET : undefined}>
                    {descriptorRowElements(
                      {
                        descriptor: activeDescriptor,
                        disabled: locked(activeDescriptor),
                        onSetOption: (value) => applyOption(activeDescriptor, value),
                        onInvokeAction: () => invokeAction(activeDescriptor),
                        ...(activeDescriptor === model ? { moreChoices: moreModels } : {}),
                        ...(permissionView
                          ? {
                              choiceLeading: (value: string) =>
                                permissionChoiceLeading(colors, value)
                            }
                          : {})
                      },
                      t
                    )}
                  </ListGroup>
                )}
                {showWorkingNotice ? <SessionOptionLockCaption /> : null}
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
                {reason ? <SessionOptionCaption>{reason}</SessionOptionCaption> : null}
              </>
            ) : (
              <>
                {homeRows.length > 0 ? (
                  <ListGroup>
                    {homeRows.flatMap((descriptor) =>
                      optionRow(descriptor, locked, applyOption, onNavigate, t)
                    )}
                  </ListGroup>
                ) : null}
                {showWorkingNotice ? <SessionOptionLockCaption /> : null}
                {permission ? (
                  <>
                    <SectionHeader
                      title={t('chat.sessionOptionPickers.permissions', 'Permissions')}
                    />
                    <ListGroup separatorInset={LIST_LEADING_INSET}>
                      {descriptorRowElements(
                        {
                          descriptor: permission,
                          disabled: locked(permission),
                          onSetOption: (value) => applyOption(permission, value),
                          onInvokeAction: () => invokeAction(permission),
                          choiceLeading: (value: string) => permissionChoiceLeading(colors, value)
                        },
                        t
                      )}
                    </ListGroup>
                    {permissionDeferred ? (
                      <SessionOptionCaption>{permissionDeferred}</SessionOptionCaption>
                    ) : null}
                  </>
                ) : null}
                <MobileNativeChatContextSection
                  usage={context?.usage ?? null}
                  {...(compact
                    ? {
                        onCompact: () => {
                          closePicker()
                          compact()
                        }
                      }
                    : {})}
                />
              </>
            )}
          </View>
        ) : null}
      </BottomDrawer>
    </View>
  )
}

/** A home row: a switch in place, or the current value with a chevron to its own list. */
function optionRow(
  descriptor: SessionOptionDescriptor,
  locked: (descriptor: SessionOptionDescriptor) => boolean,
  onSetOption: (descriptor: SessionOptionDescriptor, value: SessionOptionValue) => void,
  onNavigate: (page: string) => void,
  t: Translate
): React.JSX.Element[] {
  const say = mobileNativeChatSessionOptionSay(t)
  const disabled = locked(descriptor) || !descriptor.settable
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
      label={nativeChatSessionOptionLabel(descriptor, say)}
      value={
        descriptor.category === 'model'
          ? nativeChatModelPillLabel(descriptor, say)
          : mobileSessionOptionSummaryValue(descriptor, t)
      }
      subtitle={
        sessionOptionDispatchUnconfirmed(descriptor)
          ? t('chat.sessionOptionPickers.dispatchUnconfirmed', 'Sent to the agent — not confirmed')
          : undefined
      }
      disabled={disabled}
      onPress={
        isReadOnlySessionOptionValue(descriptor) ? undefined : () => onNavigate(descriptor.id)
      }
    />
  ]
}
