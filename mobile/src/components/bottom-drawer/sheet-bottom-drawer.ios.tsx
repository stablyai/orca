import { useEffect, useRef, useState } from 'react'
import { Keyboard, StyleSheet } from 'react-native'
import { BottomSheet, Group, Host, RNHostView } from '@expo/ui/swift-ui'
import {
  interactiveDismissDisabled,
  presentationBackgroundInteraction,
  presentationDetents,
  presentationDragIndicator,
  type PresentationDetent
} from '@expo/ui/swift-ui/modifiers'
import { spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useBottomDrawerModalHost } from './bottom-drawer-modal-host-scope'
import { MountedBottomDrawer, type MountedBottomDrawerProps } from './mounted-bottom-drawer'
import { NativeBottomDrawerBody } from './native-bottom-drawer-body'

/** A SwiftUI sheet; drawers sharing one host Modal stay drawn, as iOS can't present over it. */
export function SheetBottomDrawer(props: MountedBottomDrawerProps) {
  if (useBottomDrawerModalHost() !== null) {
    return <MountedBottomDrawer {...props} />
  }
  return <SwiftUIBottomDrawer {...props} />
}

function SwiftUIBottomDrawer({
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
  const visibleRef = useRef(visible)
  // Set by a swipe that asked the owner to close, so its dismissal waits for `visible` instead of re-presenting.
  const closeAsked = useRef(false)
  useEffect(() => {
    visibleRef.current = visible
  })
  // Each remount presents a fresh sheet, for one reopened while the last was still dismissing.
  const [generation, setGeneration] = useState(0)
  const dismissed = useRef(false)
  useEffect(() => {
    if (visible) {
      closeAsked.current = false
      return
    }
    Keyboard.dismiss()
    // A swipe's dismissal can land before the owner's close does.
    if (dismissed.current) {
      onHidden()
    }
  }, [visible, onHidden])

  return (
    <Host key={generation} colorScheme={scheme} style={SHEET_HOST_STYLE} pointerEvents="none">
      <BottomSheet
        isPresented={visible}
        fitToContents={!fillAvailable}
        // A swipe or a tap outside; a programmatic close already went through `visible`.
        onIsPresentedChange={(presented) => {
          if (!presented && visibleRef.current) {
            closeAsked.current = true
            onClose()
          }
        }}
        onDismiss={() => {
          dismissed.current = true
          if (!visibleRef.current) {
            onHidden()
          } else if (!closeAsked.current) {
            dismissed.current = false
            setGeneration((count) => count + 1)
          }
        }}
      >
        <Group
          modifiers={[
            ...(fillAvailable ? [presentationDetents(FILL_DETENTS)] : []),
            presentationDragIndicator('visible'),
            interactiveDismissDisabled(!dismissible),
            ...(dimsBackground ? [] : [presentationBackgroundInteraction('enabled')])
          ]}
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
        </Group>
      </BottomSheet>
    </Host>
  )
}

const SHEET_HOST_STYLE = { position: 'absolute' } as const
const MATCH_HEIGHT = { vertical: true } as const
const FILL_DETENTS: PresentationDetent[] = ['large']

// Clears the system grabber drawn over the sheet's top edge.
const styles = StyleSheet.create({ body: { paddingTop: spacing.xl } })
