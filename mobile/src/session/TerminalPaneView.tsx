import { useCallback } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ParsedFileLinkLocation } from '../../../src/shared/file-link-location'
import { TerminalWebView } from '../terminal/TerminalWebView'
import type {
  MobileTerminalTheme,
  TerminalKeyboardAvoidanceMetrics,
  TerminalModes,
  TerminalPointerInput,
  TerminalWebViewHandle
} from '../terminal/terminal-webview-contract'

type TerminalPaneViewProps = {
  handle: string
  active: boolean
  keyboardLift: number
  terminalTheme?: MobileTerminalTheme
  textScale: number
  onRef: (handle: string, ref: TerminalWebViewHandle | null) => void
  onWebReady: (handle: string) => void
  onSelectionMode: (handle: string, active: boolean) => void
  onSelectionCopy: (handle: string, text: string) => void
  onSelectionEvicted: (handle: string) => void
  onClipboardWrite: (handle: string, text: string) => void
  onModesChanged: (handle: string, modes: TerminalModes) => void
  onKeyboardAvoidanceMetrics: (handle: string, metrics: TerminalKeyboardAvoidanceMetrics) => void
  onHaptic: (kind: 'selection' | 'success' | 'error' | 'edge-bump') => void
  onTerminalInput: (handle: string, bytes: string, input?: TerminalPointerInput) => void
  onTerminalQueryReply: (handle: string, bytes: string) => void
  onTerminalTap: (handle: string) => void
  onFileTap: (handle: string, candidates: readonly ParsedFileLinkLocation[]) => void
  onOpenUrl: (handle: string, url: string) => void
  onTextScaleChange: (scale: number) => void
  onCellBoxChange: (handle: string) => void
}

export function TerminalPaneView({
  handle,
  active,
  keyboardLift,
  terminalTheme,
  textScale,
  onRef,
  onWebReady,
  onSelectionMode,
  onSelectionCopy,
  onSelectionEvicted,
  onClipboardWrite,
  onModesChanged,
  onKeyboardAvoidanceMetrics,
  onHaptic,
  onTerminalInput,
  onTerminalQueryReply,
  onTerminalTap,
  onFileTap,
  onOpenUrl,
  onTextScaleChange,
  onCellBoxChange
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
        textScale={textScale}
        shownAtMount={active}
        onWebReady={() => onWebReady(handle)}
        onSelectionMode={(a) => onSelectionMode(handle, a)}
        onSelectionCopy={(t) => onSelectionCopy(handle, t)}
        onSelectionEvicted={() => onSelectionEvicted(handle)}
        onClipboardWrite={(t) => onClipboardWrite(handle, t)}
        onModesChanged={(m) => onModesChanged(handle, m)}
        onKeyboardAvoidanceMetrics={(m) => onKeyboardAvoidanceMetrics(handle, m)}
        onHaptic={onHaptic}
        onTerminalInput={(bytes, input) => onTerminalInput(handle, bytes, input)}
        onTerminalQueryReply={(bytes) => onTerminalQueryReply(handle, bytes)}
        onTerminalTap={() => onTerminalTap(handle)}
        onFileTap={(candidates) => onFileTap(handle, candidates)}
        onOpenUrl={(url) => onOpenUrl(handle, url)}
        onTextScaleChange={onTextScaleChange}
        onCellBoxChange={() => onCellBoxChange(handle)}
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
