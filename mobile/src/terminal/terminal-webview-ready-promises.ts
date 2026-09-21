import { useMemo } from 'react'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

/**
 * The two promises the terminal handle hands out, and the notifies that settle them.
 *
 * `awaitReady` waits for the document's `init` rAF chain — `term.open`, renderService population,
 * first paint — because a measure that runs synchronously after init finds `term` null or cells
 * of size zero. `measureFitDimensions` waits for the document's answer. Both are promises held
 * across a message round trip, both have a timeout for the case where the document never answers,
 * and both are the same on either host, so they live here rather than in the controller that owns
 * the readiness handshake.
 */

const READY_TIMEOUT_MS = 3000
const MEASURE_TIMEOUT_MS = 2000
/** Below these the fit is not a terminal anyone can read, and the caller disables fit-to-phone. */
const MIN_FIT_COLS = 20
const MIN_FIT_ROWS = 8

export type TerminalFitDimensions = { cols: number; rows: number }

export function createTerminalWebViewReadyPromises() {
  let readyPromise: Promise<void> | null = null
  let readyResolve: (() => void) | null = null
  let measureResolve: ((result: TerminalFitDimensions | null) => void) | null = null

  /**
   * Arms a fresh ready promise, resolving any prior one first.
   *
   * Why: an awaiter from the previous generation would otherwise sit on the timeout below — each
   * leaked timer and closure pinned an awaiting measure caller for the full 3s under rapid
   * re-init (orientation change, multiple resubscribes), delaying cold-start fit chains.
   */
  function armReady() {
    const priorResolve = readyResolve
    readyResolve = null
    readyPromise = null
    priorResolve?.()
    readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve
    })
  }

  function resolveReady() {
    const resolve = readyResolve
    readyResolve = null
    readyPromise = null
    resolve?.()
  }

  async function awaitReady(): Promise<void> {
    const pending = readyPromise
    if (!pending) {
      return
    }
    await new Promise<void>((resolve) => {
      let settled = false
      const timeout = setTimeout(() => {
        settled = true
        resolve()
      }, READY_TIMEOUT_MS)
      void pending.finally(() => {
        if (!settled) {
          clearTimeout(timeout)
          settled = true
          resolve()
        }
      })
    })
  }

  function measure(
    send: (command: TerminalWebViewCommand) => void,
    containerHeight?: number
  ): Promise<TerminalFitDimensions | null> {
    return new Promise((resolve) => {
      measureResolve?.(null)
      let timeout: ReturnType<typeof setTimeout> | null = null
      const finish = (result: TerminalFitDimensions | null) => {
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        if (measureResolve === finish) {
          measureResolve = null
        }
        resolve(result)
      }
      measureResolve = finish
      send({ type: 'measure', containerHeight })
      // Why: if the document doesn't respond (e.g., xterm failed to load), resolve null so the
      // caller can disable Fit to Phone rather than hanging indefinitely.
      timeout = setTimeout(() => {
        if (measureResolve === finish) {
          finish(null)
        }
      }, MEASURE_TIMEOUT_MS)
    })
  }

  function resolveMeasure(msg: Record<string, unknown>) {
    const resolve = measureResolve
    measureResolve = null
    if (!resolve) {
      return
    }
    const cols = typeof msg.cols === 'number' ? msg.cols : null
    const rows = typeof msg.rows === 'number' ? msg.rows : null
    resolve(cols && rows && cols >= MIN_FIT_COLS && rows >= MIN_FIT_ROWS ? { cols, rows } : null)
  }

  return { armReady, awaitReady, measure, resolveMeasure, resolveReady }
}

export function useTerminalWebViewReadyPromises() {
  return useMemo(() => createTerminalWebViewReadyPromises(), [])
}
