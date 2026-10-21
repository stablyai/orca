import { useMemo } from 'react'

/**
 * The ready promise the terminal handle hands out, and the notify that settles it.
 *
 * `awaitReady` waits for the document's `init` rAF chain — `term.open`, renderService population,
 * first paint, and the cell box that init reports — so a fit after it reads the init's own box. It
 * has a timeout for a document that never answers, and is the same on either host.
 */

const READY_TIMEOUT_MS = 3000

export function createTerminalWebViewReadyPromises() {
  let readyPromise: Promise<void> | null = null
  let readyResolve: (() => void) | null = null

  /**
   * Arms a fresh ready promise, resolving any prior one first.
   *
   * Why: an awaiter from the previous generation would otherwise sit on the timeout below — each
   * leaked timer and closure pinned an awaiting fit caller for the full 3s under rapid
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

  return { armReady, awaitReady, resolveReady }
}

export function useTerminalWebViewReadyPromises() {
  return useMemo(() => createTerminalWebViewReadyPromises(), [])
}
