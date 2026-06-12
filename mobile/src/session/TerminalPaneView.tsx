import { useCallback } from 'react'
import { StyleSheet, View } from 'react-native'
import {
  TerminalWebView,
  type MobileTerminalTheme,
  type TerminalKeyboardAvoidanceMetrics,
  type TerminalModes,
  type TerminalWebViewHandle
} from '../terminal/TerminalWebView'

type TerminalPaneViewProps = {
  handle: string
  active: boolean
  keyboardLift: number
  terminalTheme?: MobileTerminalTheme
  onRef: (handle: string, ref: TerminalWebViewHandle | null) => void
  onWebReady: (handle: string) => void
  onSelectionMode: (handle: string, active: boolean) => void
  onSelectionCopy: (handle: string, text: string) => void
  onSelectionEvicted: (handle: string) => void
  onModesChanged: (handle: string, modes: TerminalModes) => void
  onKeyboardAvoidanceMetrics: (handle: string, metrics: TerminalKeyboardAvoidanceMetrics) => void
  onHaptic: (kind: 'selection' | 'success' | 'error' | 'edge-bump') => void
  onTerminalInput: (handle: string, bytes: string) => void
  onTerminalTap: (handle: string) => void
}

export function TerminalPaneView({
  handle,
  active,
  keyboardLift,
  terminalTheme,
  onRef,
  onWebReady,
  onSelectionMode,
  onSelectionCopy,
  onSelectionEvicted,
  onModesChanged,
  onKeyboardAvoidanceMetrics,
  onHaptic,
  onTerminalInput,
  onTerminalTap
}: TerminalPaneViewProps) {
  const setRef = useCallback(
    (ref: TerminalWebViewHandle | null) => {
      onRef(handle, ref)
    },
    [handle, onRef]
  )

  return (
    <View
      // Why: inactive terminal WebViews stay mounted to preserve xterm state,
      // while touch and visibility are disabled until the tab is active again.
      pointerEvents={active ? 'auto' : 'none'}
      style={[
        styles.terminalPane,
        keyboardLift > 0 && { transform: [{ translateY: -keyboardLift }] },
        !active && styles.terminalPaneHidden
      ]}
    >
      <TerminalWebView
        ref={setRef}
        style={styles.terminalWebView}
        terminalTheme={terminalTheme}
        onWebReady={() => onWebReady(handle)}
        onSelectionMode={(a) => onSelectionMode(handle, a)}
        onSelectionCopy={(t) => onSelectionCopy(handle, t)}
        onSelectionEvicted={() => onSelectionEvicted(handle)}
        onModesChanged={(m) => onModesChanged(handle, m)}
        onKeyboardAvoidanceMetrics={(m) => onKeyboardAvoidanceMetrics(handle, m)}
        onHaptic={onHaptic}
        onTerminalInput={(bytes) => onTerminalInput(handle, bytes)}
        onTerminalTap={() => onTerminalTap(handle)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  terminalPane: {
    ...StyleSheet.absoluteFillObject
  },
  terminalPaneHidden: {
    opacity: 0
  },
  terminalWebView: {
    flex: 1
  }
})
