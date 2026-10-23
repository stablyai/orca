import { useEffect, useRef } from 'react'
import { AccessibilityInfo, Keyboard, Platform, StyleSheet, View } from 'react-native'
import { FilePenLine, Hand, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { SheetHeader } from '../components/ui/SheetHeader'
import { SectionHeader } from '../components/ui/SectionHeader'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { Banner } from '../components/ui/Banner'
import { colors, spacing } from '../theme/mobile-theme'
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
  descriptorRowElements,
  ModelPill,
  SessionOptionCaption,
  SessionOptionSummaryRow
} from './MobileNativeChatSessionOptionRows'
import {
  SessionOptionSegments,
  showsSessionOptionAsSegments
} from './MobileNativeChatSessionOptionSegments'
import { sortNativeChatSessionOptions } from '../../../src/shared/native-chat-session-option-snapshot'
import {
  AGENT_CHAT_PERMISSION_MODE_ICON_NAMES,
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode
} from '../../../src/shared/agent-chat-permission-mode'
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
}

type PresentationProps = {
  presentation: MobileNativeChatPickerPresentation | null
  onNavigate: (page: string | null) => void
  /** The pill opened the drawer; fires before the keyboard is dismissed. */
  onDrawerOpen: (page: string) => void
  /** The drawer's sheet has fully left the screen, however it closed. */
  onDrawerAfterClose?: () => void
}

/** Full access reads in the warning colour wherever it is shown. */
function permissionChoiceColor(value: string | undefined): string | undefined {
  return value === 'full-access' ? colors.statusAmber : undefined
}

/** Undefined for a mode a newer host states that this build has no icon for. */
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

/** One pill for the session's model and options; its sheet also holds the permission mode. */
export function MobileNativeChatSessionOptionPickers({
  controller,
  isWorking,
  sendInFlight = false,
  presentation,
  onNavigate,
  onDrawerOpen,
  onDrawerAfterClose
}: MobileNativeChatSessionOptionPickersProps & PresentationProps): React.JSX.Element | null {
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
        'Agent is working. Model settings unlock when this turn finishes.',
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
  // The permission mode applies from the next send, so a running turn never locks it.
  const locked = isWorking || busy
  const reason = mobileSessionOptionDisabledReason(activeDescriptor?.disabledReason)
  const permissionChoice = selectedChoice(permission)
  const permissionColor = permissionChoiceColor(permissionChoice?.value)
  const fullAccess = permissionColor !== undefined
  const permissionIcon =
    !model && permissionChoice ? permissionModeIcon(permissionChoice.value) : undefined
  const segmentOptions = options.filter(showsSessionOptionAsSegments)
  const rowOptions = options.filter((descriptor) => !segmentOptions.includes(descriptor))
  const primary = model ? mobileModelPillLabel(model) : (permissionChoice?.label ?? 'Permissions')
  const secondary = model && options.length > 0 ? mobileOptionsPillLabel(options) : null

  const closePicker = (): void => onNavigate(null)
  const applyOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    // Re-picking the tracked value is a no-op — never re-dispatch it.
    if (
      descriptor.valueSource !== 'unknown' &&
      descriptor.kind.type === 'select' &&
      descriptor.kind.currentValue === value
    ) {
      return
    }
    // A permission pick shows at once; its write may wait behind a starting agent.
    if (descriptor === permission) {
      onNavigate(descriptor === home ? null : home.id)
    }
    void controller.setOption(descriptor.id, value).then((applied) => {
      // The sheet stays on its home page so the next setting is one tap away; a sub page returns.
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

  const permissionLeading = (value: string) => {
    const Icon = permissionModeIcon(value)
    return Icon ? (
      <Icon
        size={18}
        color={permissionChoiceColor(value) ?? colors.textSecondary}
        strokeWidth={2.2}
      />
    ) : null
  }
  const pageRows = activeDescriptor
    ? descriptorRowElements({
        descriptor: activeDescriptor,
        disabled: permissionView ? busy : locked,
        onSetOption: (value) => applyOption(activeDescriptor, value),
        onInvokeAction: () => invokeAction(activeDescriptor),
        ...(permissionView ? { choiceLeading: permissionLeading } : {})
      })
    : []

  return (
    <View style={styles.pillSlot}>
      <ModelPill
        primary={primary}
        secondary={secondary}
        warning={fullAccess}
        icon={permissionIcon}
        accessibleName={
          model
            ? `Model, ${secondary ? `${primary} ${secondary}` : primary}${fullAccess ? ', full access' : ''}`
            : `Permissions, ${primary}`
        }
        disabled={busy}
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
            <SheetHeader
              title={activeDescriptor.label}
              subtitle={pendingId !== null ? 'Applying…' : undefined}
              leading={homeView ? undefined : { label: 'Back', onPress: () => onNavigate(home.id) }}
              trailing={{ label: 'Done', onPress: closePicker }}
            />
            {showWorkingNotice ? (
              <View style={styles.notice} accessibilityLiveRegion="polite">
                <Banner
                  title="Agent is working"
                  message="Model settings unlock when this turn finishes."
                />
              </View>
            ) : null}
            {homeView && model ? (
              <SectionHeader title="Model" first />
            ) : (
              <View style={styles.pageTop} />
            )}
            <ListGroup separatorInset={permissionView ? LIST_LEADING_INSET : undefined}>
              {pageRows}
            </ListGroup>
            {sessionOptionDispatchUnconfirmed(activeDescriptor) ? (
              <SessionOptionCaption>Sent to the agent, not confirmed yet.</SessionOptionCaption>
            ) : null}
            {reason ? <SessionOptionCaption>{reason}</SessionOptionCaption> : null}
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

/** The model page's other settings: a switch where one value flips, else a row to its page. */
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
  if (descriptors.length === 0) {
    return null
  }
  return (
    <>
      <SectionHeader title="Options" />
      <ListGroup>
        {descriptors.flatMap((descriptor) => {
          const isPermission = descriptor === permission
          const disabled = isPermission ? busy : locked
          if (descriptor.kind.type === 'boolean' && !descriptor.action) {
            return descriptorRowElements({
              descriptor,
              disabled,
              onSetOption: (value) => onSetOption(descriptor, value),
              onInvokeAction: () => onNavigate(descriptor.id)
            })
          }
          return [
            <SessionOptionSummaryRow
              key={descriptor.id}
              label={isPermission ? 'Permissions' : descriptor.label}
              value={mobileSessionOptionSummaryValue(descriptor)}
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

const styles = StyleSheet.create({
  // The action row's only shrinkable item: a long label truncates before it pushes Send off.
  pillSlot: {
    flexShrink: 1,
    minWidth: 0
  },
  // The drawer pads its content; the sheet's groups and headers keep their own 16 and 20 pt edges.
  sheet: {
    marginHorizontal: -spacing.md,
    paddingBottom: spacing.lg
  },
  notice: {
    paddingTop: spacing.xs
  },
  pageTop: {
    height: spacing.sm
  }
})
