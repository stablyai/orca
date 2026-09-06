import { useCallback, useRef } from 'react'
import type { TerminalLiveHardwareKeyEvent } from './terminal-live-hardware-key-mapping'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'

export function useTerminalNativeFieldBoundary(
  connected: boolean,
  activeHandle: string | null,
  liveHandles: ReadonlySet<string>,
  applyMirror: (handle: string, text: string, composing?: boolean) => Promise<boolean>
) {
  const nativeFieldBoundaryRef = useRef<{ target: number; eventCount: number } | null>(null)
  const acceptNativeFieldBoundary = useCallback(
    (boundary: TerminalLiveHardwareKeyEvent['fieldBoundary']) => {
      if (!boundary) {
        return true
      }
      if (!connected || !activeHandle || !liveHandles.has(activeHandle)) {
        return false
      }
      const previous = nativeFieldBoundaryRef.current
      if (previous?.target === boundary.target && previous.eventCount >= boundary.eventCount) {
        return false
      }
      nativeFieldBoundaryRef.current = { target: boundary.target, eventCount: boundary.eventCount }
      void applyMirror(activeHandle, normalizeTerminalTextInput(boundary.text), false)
      return true
    },
    [connected, activeHandle, liveHandles, applyMirror]
  )
  return { nativeFieldBoundaryRef, acceptNativeFieldBoundary }
}
