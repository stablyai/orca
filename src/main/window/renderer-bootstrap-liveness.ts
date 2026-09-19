import { is } from '@electron-toolkit/utils'
import { observeRendererBootstrap } from './renderer-bootstrap-signal'

/**
 * `did-finish-load` only proves Chromium finished fetching a document; a document whose entry
 * module never evaluated fires it too. Bundle F0C17E8TVU0 (1.4.198, Windows) spent 17m23s on
 * exactly that window — main recorded `main_window_loaded` as a success while the renderer held
 * 139 MB and ran no JavaScript. The one thing that separates the two is the renderer saying so.
 */

// Why 30s and not less: the confirmation is sent during entry-module evaluation, which the load
// event already waits for, so the real budget is main-process IPC *delivery* latency, not renderer
// work. The same bundle shows main blocked on 13.6s git calls under commit exhaustion, so a queued
// message can sit that long; 30s is ~2.2x the worst stall observed there. Why not more: every extra
// second is white window the user stares at, and 30s is still 35x shorter than the field failure.
export const RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS = 30_000
// Why separate: a Vite cold start refetches the whole module graph over HTTP under a debugger-
// friendly transform. Dev already budgets 180s for a recovery load; matching it keeps a slow but
// healthy dev boot out of the blank-window path entirely.
export const RENDERER_BOOTSTRAP_CONFIRM_DEV_TIMEOUT_MS = 180_000

export type RendererBootstrapLivenessGate = {
  /** A new main-frame document committed; its predecessor's confirmation no longer counts. */
  notifyDocumentNavigated: () => void
  /** A main-frame document finished loading and now owes a bootstrap confirmation. */
  notifyDocumentLoaded: () => void
  /** Restarts an outstanding deadline that a suspend froze; see notifySystemResume below. */
  notifySystemResume: () => void
  clear: () => void
}

/** Match loadMainWindow's dev/prod branch, which decides how the document is fetched. */
function confirmTimeoutMs(): number {
  return is.dev && process.env.ELECTRON_RENDERER_URL
    ? RENDERER_BOOTSTRAP_CONFIRM_DEV_TIMEOUT_MS
    : RENDERER_BOOTSTRAP_CONFIRM_TIMEOUT_MS
}

/**
 * Holds each landed document to a deadline for proving its JavaScript ran.
 * `onBootstrapAbsent` carries how many documents in a row have failed to prove it, so the caller
 * can bound recovery instead of reloading a permanently broken build forever.
 */
export function createRendererBootstrapLivenessGate(args: {
  /** Returns false when the caller declined to act on this blank document. */
  onBootstrapAbsent: (info: { consecutiveUnconfirmed: number; waitedMs: number }) => boolean
  rendererWebContentsId: number
}): RendererBootstrapLivenessGate {
  const { onBootstrapAbsent, rendererWebContentsId } = args
  let timer: ReturnType<typeof setTimeout> | null = null
  // Why a flag and not just the timer: the entry module runs before the load event, so the
  // confirmation normally arrives BEFORE did-finish-load. Arming a deadline that is already
  // satisfied would reload a working app out from under the user.
  let bootstrappedThisDocument = false
  let consecutiveUnconfirmed = 0

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }
  const confirmBootstrap = (): void => {
    bootstrappedThisDocument = true
    consecutiveUnconfirmed = 0
    clearTimer()
  }
  const unobserve = observeRendererBootstrap(rendererWebContentsId, confirmBootstrap)
  const armDeadline = (): void => {
    clearTimer()
    const waitedMs = confirmTimeoutMs()
    timer = setTimeout(() => {
      timer = null
      // Count the strike only once it is acted on: a blank document suppressed behind a prompt or a
      // queued crash recovery would otherwise spend the single retry the next one needs.
      const streak = consecutiveUnconfirmed + 1
      if (onBootstrapAbsent({ consecutiveUnconfirmed: streak, waitedMs })) {
        consecutiveUnconfirmed = streak
      }
    }, waitedMs)
    timer.unref?.()
  }

  return {
    notifyDocumentNavigated: () => {
      bootstrappedThisDocument = false
      // Only did-finish-load re-arms: a renderer-initiated navigation that commits and then never
      // finishes loading leaves nobody holding it, since the stall watchdog watches main's reloads.
      clearTimer()
    },
    notifyDocumentLoaded: () => {
      if (bootstrappedThisDocument) {
        return
      }
      armDeadline()
    },
    notifySystemResume: () => {
      // Suspended time counts against the deadline, so it wakes already expired and would reload a
      // healthy renderer whose confirmation is merely queued. Only a document still owing proof.
      if (!timer) {
        return
      }
      armDeadline()
    },
    clear: () => {
      clearTimer()
      unobserve()
    }
  }
}
