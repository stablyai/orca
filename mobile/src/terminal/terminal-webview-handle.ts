import type { RefObject } from 'react'
import { PixelRatio, Platform } from 'react-native'
import type { MobileTerminalTheme, TerminalWebViewHandle } from './terminal-webview-contract'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import type { createTerminalWriteCoalescer } from './terminal-write-coalescer'

type ViewportDimensions = { cols: number; rows: number }

export function createTerminalWebViewHandle({
  armWebReadyWatchdog,
  isWebReadyRef,
  measureResolveRef,
  pendingPingIdRef,
  postMessage,
  readyPromiseRef,
  readyResolveRef,
  sendToWebView,
  terminalTheme,
  textScale,
  writeCoalescer
}: {
  armWebReadyWatchdog: () => void
  isWebReadyRef: RefObject<boolean>
  measureResolveRef: RefObject<((result: ViewportDimensions | null) => void) | null>
  pendingPingIdRef: RefObject<number | null>
  postMessage: (message: TerminalWebViewCommand) => void
  readyPromiseRef: RefObject<Promise<void> | null>
  readyResolveRef: RefObject<(() => void) | null>
  sendToWebView: (message: TerminalWebViewCommand) => number
  terminalTheme?: MobileTerminalTheme
  textScale: number
  writeCoalescer: ReturnType<typeof createTerminalWriteCoalescer>
}): TerminalWebViewHandle {
  return {
    prepareForForegroundRecovery() {
      if (Platform.OS !== 'ios') {
        return
      }
      isWebReadyRef.current = false
      armWebReadyWatchdog()
      pendingPingIdRef.current = sendToWebView({ type: 'ping' })
    },
    write(data: string) {
      writeCoalescer.write(data)
    },
    init(
      cols: number,
      rows: number,
      initialData?: string,
      preserveScroll?: boolean,
      oscLinks?: Parameters<TerminalWebViewHandle['init']>[4]
    ) {
      const priorResolve = readyResolveRef.current
      if (priorResolve) {
        readyResolveRef.current = null
        readyPromiseRef.current = null
        priorResolve()
      }
      readyPromiseRef.current = new Promise<void>((resolve) => {
        readyResolveRef.current = resolve
      })
      writeCoalescer.clear()
      postMessage({
        type: 'init',
        cols,
        rows,
        initialData,
        oscLinks,
        terminalTheme,
        fontScale: textScale,
        preserveScroll
      })
    },
    resize(cols: number, rows: number) {
      writeCoalescer.flushNow()
      postMessage({ type: 'resize', cols, rows })
    },
    reflow(cols: number, rows: number) {
      writeCoalescer.flushNow()
      postMessage({ type: 'reflow', cols, rows })
    },
    clear() {
      writeCoalescer.clear()
      postMessage({ type: 'clear' })
    },
    measureFitDimensions(containerHeight, containerWidth) {
      if (!isWebReadyRef.current) {
        return Promise.resolve(null)
      }
      return new Promise((resolve) => {
        measureResolveRef.current?.(null)
        let timeout: ReturnType<typeof setTimeout> | null = null
        const finish = (result: ViewportDimensions | null) => {
          if (timeout) {
            clearTimeout(timeout)
          }
          timeout = null
          if (measureResolveRef.current === finish) {
            measureResolveRef.current = null
          }
          resolve(result)
        }
        measureResolveRef.current = finish
        sendToWebView({ type: 'measure', containerHeight, containerWidth })
        timeout = setTimeout(() => {
          if (measureResolveRef.current === finish) {
            finish(null)
          }
        }, 2000)
      })
    },
    setViewport(width, height) {
      postMessage({ type: 'set-viewport', width, height, dpr: PixelRatio.get() })
    },
    resetZoom: () => postMessage({ type: 'reset-zoom' }),
    cancelSelect: () => postMessage({ type: 'cancel-select' }),
    doSelectAll: () => postMessage({ type: 'do-select-all' }),
    async awaitReady() {
      const pending = readyPromiseRef.current
      if (!pending) {
        return
      }
      await new Promise<void>((resolve) => {
        let settled = false
        const timeout = setTimeout(() => {
          settled = true
          resolve()
        }, 3000)
        void pending.finally(() => {
          if (settled) {
            return
          }
          clearTimeout(timeout)
          settled = true
          resolve()
        })
      })
    }
  }
}
