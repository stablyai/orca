import { parseTerminalKittyKeyboardFlags } from '../../../src/shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'
import { useCallback, useMemo, type RefObject } from 'react'
import type { TerminalCellBox } from './terminal-cell-box'
import { fitDimensionsFromCell } from './terminal-grid-fit'
import type {
  MobileTerminalTheme,
  TerminalInit,
  TerminalWebViewHandle
} from './terminal-webview-contract'
import type { TerminalFrame, TerminalWebViewCommand } from './terminal-webview-messages'
import type { useTerminalWebViewReadyPromises } from './terminal-webview-ready-promises'
import type { createTerminalWriteCoalescer } from './terminal-write-coalescer'

type UseTerminalWebViewHandleOptions = {
  readonly armWebReadyWatchdog: () => void
  readonly cellBoxRef: RefObject<TerminalCellBox | null>
  readonly isWebReadyRef: RefObject<boolean>
  readonly pendingPingIdRef: RefObject<number | null>
  readonly pingsOnForegroundRecovery: () => boolean
  readonly postMessage: (msg: TerminalWebViewCommand) => void
  readonly promises: ReturnType<typeof useTerminalWebViewReadyPromises>
  readonly sendToDocument: (msg: TerminalWebViewCommand) => number
  readonly terminalTheme: MobileTerminalTheme | undefined
  readonly textScale: number
  readonly writeCoalescer: ReturnType<typeof createTerminalWriteCoalescer>
}

export function useTerminalWebViewHandle({
  armWebReadyWatchdog,
  cellBoxRef,
  isWebReadyRef,
  pendingPingIdRef,
  pingsOnForegroundRecovery,
  postMessage,
  promises,
  sendToDocument,
  terminalTheme,
  textScale,
  writeCoalescer
}: UseTerminalWebViewHandleOptions): TerminalWebViewHandle {
  const fitDimensions = useCallback(
    (frame: TerminalFrame) => {
      const cell = cellBoxRef.current
      // A cell box measured at another text scale cannot authorize this grid’s fit.
      return cell && cell.fontScale === textScale && frame.width > 0 && frame.height > 0
        ? fitDimensionsFromCell(cell, frame.width, frame.height)
        : null
    },
    [cellBoxRef, textScale]
  )

  return useMemo<TerminalWebViewHandle>(
    () => ({
      prepareForForegroundRecovery() {
        if (!pingsOnForegroundRecovery()) {
          return
        }
        // Only direct ping bypasses invalid readiness; queue init/write until this exact document proves liveness.
        isWebReadyRef.current = false
        armWebReadyWatchdog()
        pendingPingIdRef.current = sendToDocument({ type: 'ping' })
      },
      write(data: string) {
        writeCoalescer.write(data)
      },
      init({ cols, rows, initialData, preserveScroll, oscLinks, kittyFlags, frame }: TerminalInit) {
        // Arm ready before posting init so a synchronous reply cannot be lost.
        promises.armReady()
        // The init snapshot supersedes buffered chunks; replaying them afterward would duplicate old output.
        writeCoalescer.clear()
        postMessage({
          type: 'init',
          cols,
          rows,
          initialData,
          oscLinks,
          kittyKeyboardFlags: parseTerminalKittyKeyboardFlags(kittyFlags),
          terminalTheme,
          fontScale: textScale,
          preserveScroll,
          frame
        })
      },
      resize(cols: number, rows: number, frame: TerminalFrame | null) {
        // Flush prior writes before resize/reflow so terminal bytes stay ordered.
        writeCoalescer.flushNow()
        postMessage({ type: 'resize', cols, rows, frame })
      },
      reflow(cols: number, rows: number, frame: TerminalFrame | null) {
        writeCoalescer.flushNow()
        postMessage({ type: 'reflow', cols, rows, frame })
      },
      clear() {
        writeCoalescer.clear()
        postMessage({ type: 'clear' })
      },
      fitDimensions,
      scrollToBottom() {
        writeCoalescer.flushNow()
        postMessage({ type: 'scroll-to-bottom' })
      },
      resetZoom() {
        postMessage({ type: 'reset-zoom' })
      },
      cancelSelect() {
        postMessage({ type: 'cancel-select' })
      },
      doSelectAll() {
        postMessage({ type: 'do-select-all' })
      },
      awaitReady: promises.awaitReady
    }),
    [
      armWebReadyWatchdog,
      fitDimensions,
      isWebReadyRef,
      pendingPingIdRef,
      pingsOnForegroundRecovery,
      postMessage,
      promises,
      sendToDocument,
      terminalTheme,
      textScale,
      writeCoalescer
    ]
  )
}
