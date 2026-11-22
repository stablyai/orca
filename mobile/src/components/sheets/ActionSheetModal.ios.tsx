import { useEffect, useRef, useState } from 'react'
import { ActionSheetIOS, View } from 'react-native'
import {
  BottomSheet,
  Button,
  Group,
  HStack,
  Host,
  Image,
  List,
  NavigationStack,
  ProgressView,
  RNHostView,
  Section,
  Spacer,
  Text,
  VStack
} from '@expo/ui/swift-ui'
import {
  accessibilityAddTraits,
  disabled,
  font,
  foregroundStyle,
  listStyle,
  navigationBarTitleDisplayMode,
  navigationTitle,
  presentationDetents,
  presentationDragIndicator
} from '@expo/ui/swift-ui/modifiers'
import type { SFSymbol } from 'expo-symbols'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBottomDrawerModalHost } from '../bottom-drawer/bottom-drawer-modal-host-scope'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { actionSheetTitleText, useActionSheetPress } from './action-sheet-press'
import type { ActionSheetAction, ActionSheetModalProps } from './ActionSheetContent'
import { DrawnActionSheetModal } from './DrawnActionSheetModal'

export { ActionSheetContent } from './ActionSheetContent'
export type { ActionSheetAction, ActionSheetModalProps } from './ActionSheetContent'

// More rows than a half-height sheet shows get the full-height detent too.
const HALF_SHEET_ROWS = 6

// A UIKit action sheet holds only labelled buttons and closes on any tap.
function needsListSheet(actions: readonly ActionSheetAction[]): boolean {
  return actions.some(
    (action) =>
      action.renderIcon !== undefined ||
      action.hint !== undefined ||
      action.status !== undefined ||
      action.checked !== undefined ||
      action.loading === true ||
      action.skipAutoClose === true
  )
}

/** Plain choices raise the system action sheet; rows with icons, checks or state get a sheet with a list. */
export function ActionSheetModal(props: ActionSheetModalProps) {
  // A shared drawer Modal can unmount under a sheet in its own window, so those keep the drawn one.
  if (useBottomDrawerModalHost() !== null) {
    return <DrawnActionSheetModal {...props} />
  }
  return <NativeActionSheet {...props} />
}

function NativeActionSheet(props: ActionSheetModalProps) {
  const [listSheet, setListSheet] = useState(() => needsListSheet(props.actions))
  const [wasVisible, setWasVisible] = useState(props.visible)
  // The kind is fixed per opening, so a row that starts loading can't swap one sheet for the other.
  if (props.visible !== wasVisible) {
    setWasVisible(props.visible)
    if (props.visible) {
      setListSheet(needsListSheet(props.actions))
    }
  }
  return (
    <>
      <SystemActionSheet {...props} visible={props.visible && !listSheet} />
      <ListActionSheet {...props} visible={props.visible && listSheet} />
    </>
  )
}

function SystemActionSheet(props: ActionSheetModalProps) {
  const t = useMobileTranslation()
  const scheme = useMobileColorScheme()
  const latest = useRef({ props, t, scheme })
  useEffect(() => {
    latest.current = { props, t, scheme }
  })
  const shown = useRef(false)

  useEffect(() => {
    if (!props.visible) {
      // Closed from outside while up: UIKit sends no callback for that, so finish here.
      if (shown.current) {
        shown.current = false
        ActionSheetIOS.dismissActionSheet()
        latest.current.props.onAfterClose?.()
      }
      return
    }
    const { props: opened, t: translate, scheme: style } = latest.current
    const { actions } = opened
    const destructive = actions.flatMap((action, index) => (action.destructive ? [index] : []))
    const unavailable = actions.flatMap((action, index) => (action.disabled ? [index] : []))
    shown.current = true
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: actionSheetTitleText(opened.title, opened.titleAccessibilityLabel),
        message: opened.message,
        options: [...actions.map((action) => action.label), translate('common.cancel', 'Cancel')],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: destructive,
        ...(unavailable.length > 0 ? { disabledButtonIndices: unavailable } : {}),
        userInterfaceStyle: style
      },
      // UIKit calls back once the sheet is gone, so every action already runs after dismissal.
      (index) => {
        if (!shown.current) {
          return
        }
        shown.current = false
        const action = actions[index]
        const { onClose, onAfterClose } = latest.current.props
        if (action?.closeBeforePress) {
          onClose()
          action.onPress()
        } else {
          action?.onPress()
          onClose()
        }
        onAfterClose?.()
      }
    )
  }, [props.visible])

  useEffect(
    () => () => {
      if (shown.current) {
        shown.current = false
        ActionSheetIOS.dismissActionSheet()
      }
    },
    []
  )

  return null
}

function ListActionSheet({
  visible,
  title,
  titleAccessibilityLabel,
  message,
  actions,
  onClose,
  onAfterClose
}: ActionSheetModalProps) {
  const scheme = useMobileColorScheme()
  const { press, flush } = useActionSheetPress(onClose)
  const visibleRef = useRef(visible)
  useEffect(() => {
    visibleRef.current = visible
  })
  const heading = actionSheetTitleText(title, titleAccessibilityLabel)

  const list = (
    <List
      modifiers={[
        listStyle('insetGrouped'),
        ...(heading ? [navigationTitle(heading), navigationBarTitleDisplayMode('inline')] : [])
      ]}
    >
      <Section header={message ? <Text>{message}</Text> : undefined}>
        {actions.map((action) => (
          <ActionRow key={action.id ?? action.label} action={action} onPress={press} />
        ))}
      </Section>
    </List>
  )

  return (
    <Host colorScheme={scheme} style={SHEET_HOST_STYLE} pointerEvents="none">
      <BottomSheet
        isPresented={visible}
        // A swipe or a tap outside; a row press has already closed through `onClose`.
        onIsPresentedChange={(presented) => {
          if (!presented && visibleRef.current) {
            onClose()
          }
        }}
        onDismiss={() => {
          flush()
          onAfterClose?.()
        }}
      >
        <Group
          modifiers={[
            presentationDetents(
              actions.length > HALF_SHEET_ROWS ? ['medium', 'large'] : ['medium']
            ),
            presentationDragIndicator('visible')
          ]}
        >
          {heading ? <NavigationStack>{list}</NavigationStack> : list}
        </Group>
      </BottomSheet>
    </Host>
  )
}

function ActionRow({
  action,
  onPress
}: {
  action: ActionSheetAction
  onPress: (action: ActionSheetAction) => void
}) {
  const symbol = action.icon?.nativeSymbol?.ios
  const inactive = action.disabled === true || action.loading === true
  return (
    <Button
      role={action.destructive ? 'destructive' : undefined}
      onPress={() => onPress(action)}
      modifiers={[
        disabled(inactive),
        ...(action.checked ? [accessibilityAddTraits(['isSelected'])] : [])
      ]}
    >
      <HStack spacing={12}>
        {action.renderIcon ? (
          <RNHostView matchContents>
            <View>{action.renderIcon()}</View>
          </RNHostView>
        ) : symbol ? (
          <Image systemName={symbol as SFSymbol} />
        ) : null}
        <VStack alignment="leading" spacing={2}>
          {/* A destructive row keeps the red its role gives it. */}
          <Text
            modifiers={
              action.destructive ? [] : [foregroundStyle(action.disabled ? TERTIARY : PRIMARY)]
            }
          >
            {action.label}
          </Text>
          {action.hint ? (
            <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle(SECONDARY)]}>
              {action.hint}
            </Text>
          ) : null}
        </VStack>
        <Spacer />
        {action.status ? (
          <Text modifiers={[foregroundStyle(SECONDARY)]}>{action.status}</Text>
        ) : null}
        {action.loading ? <ProgressView /> : null}
        {action.checked ? (
          <Image
            systemName="checkmark"
            modifiers={[font({ textStyle: 'body', weight: 'semibold' })]}
          />
        ) : null}
      </HStack>
    </Button>
  )
}

const SHEET_HOST_STYLE = { position: 'absolute' } as const
const PRIMARY = { type: 'hierarchical', style: 'primary' } as const
const SECONDARY = { type: 'hierarchical', style: 'secondary' } as const
const TERTIARY = { type: 'hierarchical', style: 'tertiary' } as const
