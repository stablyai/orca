import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import {
  CircularProgressIndicator,
  Column,
  Host,
  Icon,
  ListItem,
  ModalBottomSheet,
  RNHostView,
  Row,
  Text,
  type ModalBottomSheetRef
} from '@expo/ui/jetpack-compose'
import {
  alpha,
  clickable,
  fillMaxWidth,
  padding,
  size,
  verticalScroll
} from '@expo/ui/jetpack-compose/modifiers'
import { colors, materialSeedColor } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useBottomDrawerModalHost } from '../bottom-drawer/bottom-drawer-modal-host-scope'
import { useMaterialSymbolImages } from '../icons/material-symbol-images'
import { actionSheetTitleText, useActionSheetPress } from './action-sheet-press'
import type { ActionSheetModalProps } from './ActionSheetContent'
import { DIALOG_HOST_STYLE } from './native-dialog-host'
import { DrawnActionSheetModal } from './DrawnActionSheetModal'

export { ActionSheetContent } from './ActionSheetContent'
export type { ActionSheetAction, ActionSheetModalProps } from './ActionSheetContent'

// Material 3's disabled content opacity.
const DISABLED_ALPHA = 0.38
const CHECK_SYMBOL = 'check'
const ICON_SIZE = 24
const SPINNER_SIZE = 20

/** A Material 3 modal bottom sheet of list items. */
export function ActionSheetModal(props: ActionSheetModalProps) {
  // A shared drawer Modal can unmount under a sheet in its own window, so those keep the drawn one.
  if (useBottomDrawerModalHost() !== null) {
    return <DrawnActionSheetModal {...props} />
  }
  return <MaterialActionSheet {...props} />
}

function MaterialActionSheet({
  visible,
  title,
  titleAccessibilityLabel,
  message,
  actions,
  onClose,
  onAfterClose
}: ActionSheetModalProps) {
  const scheme = useMobileColorScheme()
  const sheetRef = useRef<ModalBottomSheetRef>(null)
  const { press, flush } = useActionSheetPress(onClose)
  const images = useMaterialSymbolImages(
    visible
      ? [CHECK_SYMBOL, ...actions.flatMap((action) => action.icon?.nativeSymbol?.android ?? [])]
      : []
  )
  // The sheet stays composed through its hide animation; each closing gets a fresh one next time.
  const [open, setOpen] = useState(visible)
  const [closings, setClosings] = useState(0)
  if (visible && !open) {
    setOpen(true)
  }
  const latest = useRef({ visible, onAfterClose, flush })
  useEffect(() => {
    latest.current = { visible, onAfterClose, flush }
  })
  const hiding = useRef(false)
  useEffect(() => {
    if (visible || !open || hiding.current) {
      return
    }
    hiding.current = true
    void Promise.resolve(sheetRef.current?.hide())
      .catch(() => undefined)
      .then(() => {
        hiding.current = false
        setClosings((count) => count + 1)
        setOpen(latest.current.visible)
      })
  }, [visible, open])
  useEffect(() => {
    if (closings > 0) {
      latest.current.flush()
      latest.current.onAfterClose?.()
    }
  }, [closings])

  if (!open) {
    return null
  }
  const heading = actionSheetTitleText(title, titleAccessibilityLabel)
  return (
    <Host
      matchContents
      colorScheme={scheme}
      seedColor={materialSeedColor}
      style={DIALOG_HOST_STYLE}
    >
      <ModalBottomSheet
        key={closings}
        ref={sheetRef}
        // A swipe, the scrim or Back; a row press has already closed through `onClose`.
        onDismissRequest={() => {
          if (latest.current.visible) {
            onClose()
          }
        }}
      >
        <Column modifiers={[fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 16)]}>
          {heading ? (
            <Text style={{ typography: 'titleMedium' }} modifiers={[padding(16, 0, 16, 4)]}>
              {heading}
            </Text>
          ) : null}
          {message ? (
            <Text
              style={{ typography: 'bodyMedium' }}
              color={colors.textSecondary}
              modifiers={[padding(16, 0, 16, 8)]}
            >
              {message}
            </Text>
          ) : null}
          {actions.map((action) => {
            const symbol = action.icon?.nativeSymbol?.android
            const icon = symbol ? images.get(symbol) : undefined
            const check = images.get(CHECK_SYMBOL)
            const inactive = action.disabled === true || action.loading === true
            return (
              <ListItem
                key={action.id ?? action.label}
                colors={{
                  containerColor: TRANSPARENT,
                  ...(action.destructive
                    ? { contentColor: colors.statusRed, leadingContentColor: colors.statusRed }
                    : {})
                }}
                modifiers={[
                  ...(inactive ? [] : [clickable(() => press(action))]),
                  ...(action.disabled ? [alpha(DISABLED_ALPHA)] : [])
                ]}
              >
                <ListItem.HeadlineContent>
                  <Text>{action.label}</Text>
                </ListItem.HeadlineContent>
                {action.hint ? (
                  <ListItem.SupportingContent>
                    <Text>{action.hint}</Text>
                  </ListItem.SupportingContent>
                ) : null}
                {action.renderIcon ? (
                  <ListItem.LeadingContent>
                    <RNHostView matchContents>
                      <View>{action.renderIcon()}</View>
                    </RNHostView>
                  </ListItem.LeadingContent>
                ) : icon ? (
                  <ListItem.LeadingContent>
                    <Icon source={icon} size={ICON_SIZE} />
                  </ListItem.LeadingContent>
                ) : null}
                {action.loading || action.status || (action.checked && check) ? (
                  <ListItem.TrailingContent>
                    <Row verticalAlignment="center" horizontalArrangement={{ spacedBy: 8 }}>
                      {action.status ? <Text>{action.status}</Text> : null}
                      {action.loading ? (
                        <CircularProgressIndicator modifiers={[size(SPINNER_SIZE, SPINNER_SIZE)]} />
                      ) : action.checked && check ? (
                        <Icon source={check} size={ICON_SIZE} />
                      ) : null}
                    </Row>
                  </ListItem.TrailingContent>
                ) : null}
              </ListItem>
            )
          })}
        </Column>
      </ModalBottomSheet>
    </Host>
  )
}

const TRANSPARENT = 'transparent'
