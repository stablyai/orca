import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Keyboard, StyleSheet } from 'react-native'
import {
  Host,
  ModalBottomSheet,
  RNHostView,
  type ModalBottomSheetRef
} from '@expo/ui/jetpack-compose'
import { colors, materialSeedColor, spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { DIALOG_HOST_STYLE } from '../sheets/native-dialog-host'
import { useBottomDrawerModalHost } from './bottom-drawer-modal-host-scope'
import { MountedBottomDrawer, type MountedBottomDrawerProps } from './mounted-bottom-drawer'
import { NativeBottomDrawerBody } from './native-bottom-drawer-body'

/** A Material 3 modal bottom sheet; drawers sharing one host Modal stay drawn inside it. */
export function SheetBottomDrawer(props: MountedBottomDrawerProps) {
  if (useBottomDrawerModalHost() !== null) {
    return <MountedBottomDrawer {...props} />
  }
  return <MaterialBottomDrawer {...props} />
}

function MaterialBottomDrawer({
  visible,
  onClose,
  onHidden,
  children,
  contentScrollable,
  fillAvailable = false,
  dismissible = true,
  scrollResetKey,
  dimsBackground = true
}: MountedBottomDrawerProps) {
  const scheme = useMobileColorScheme()
  const sheetRef = useRef<ModalBottomSheetRef>(null)
  const latest = useRef({ visible, onHidden })
  // Set during commit: a hide that completes right after a reopen must see the reopen.
  useLayoutEffect(() => {
    latest.current = { visible, onHidden }
  })
  // Each remount composes a fresh sheet, for one reopened while the last was hiding.
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    if (visible) {
      return
    }
    Keyboard.dismiss()
    // Not cancelled by a reopen: the sheet keeps hiding, and the reopen then composes a new one.
    void Promise.resolve(sheetRef.current?.hide())
      .catch(() => undefined)
      .then(() => {
        if (latest.current.visible) {
          setGeneration((count) => count + 1)
        } else {
          latest.current.onHidden()
        }
      })
  }, [visible])

  return (
    <Host
      key={generation}
      matchContents
      colorScheme={scheme}
      seedColor={materialSeedColor}
      style={DIALOG_HOST_STYLE}
    >
      <ModalBottomSheet
        ref={sheetRef}
        skipPartiallyExpanded
        containerColor={colors.sheetSurface}
        scrimColor={dimsBackground ? undefined : TRANSPARENT}
        sheetGesturesEnabled={dismissible}
        properties={dismissible ? DISMISSIBLE : HELD}
        // A swipe, the scrim or Back; a programmatic close already went through `visible`.
        onDismissRequest={() => {
          if (latest.current.visible) {
            onClose()
          }
        }}
      >
        <RNHostView matchContents={fillAvailable ? false : MATCH_HEIGHT}>
          <NativeBottomDrawerBody
            style={styles.body}
            contentScrollable={contentScrollable}
            fillAvailable={fillAvailable}
            scrollResetKey={scrollResetKey}
          >
            {children}
          </NativeBottomDrawerBody>
        </RNHostView>
      </ModalBottomSheet>
    </Host>
  )
}

const TRANSPARENT = 'transparent'
const MATCH_HEIGHT = { vertical: true } as const
const DISMISSIBLE = { shouldDismissOnBackPress: true, shouldDismissOnClickOutside: true }
const HELD = { shouldDismissOnBackPress: false, shouldDismissOnClickOutside: false }

// The Material drag handle already spaces the content from the sheet's top edge.
const styles = StyleSheet.create({ body: { paddingTop: spacing.xs } })
