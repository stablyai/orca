import { useCallback, type RefObject } from 'react'
import type { LayoutChangeEvent } from 'react-native'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

export function useTerminalFrameLayout({
  terminalRefs,
  heightRef,
  widthRef,
  onHeightChange,
  onWidthChange
}: {
  terminalRefs: RefObject<Map<string, TerminalWebViewHandle>>
  heightRef: RefObject<number>
  widthRef: RefObject<number>
  onHeightChange: (height: number) => void
  onWidthChange: (width: number) => void
}) {
  return useCallback(
    (event: LayoutChangeEvent) => {
      const width = Math.round(event.nativeEvent.layout.width)
      const height = Math.round(event.nativeEvent.layout.height)
      widthRef.current = width
      heightRef.current = height
      for (const terminalRef of terminalRefs.current.values()) {
        terminalRef.setViewport(width, height)
      }
      onWidthChange(width)
      onHeightChange(height)
    },
    [heightRef, onHeightChange, onWidthChange, terminalRefs, widthRef]
  )
}
