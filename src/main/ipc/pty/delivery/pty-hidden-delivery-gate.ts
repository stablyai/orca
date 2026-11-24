/** Drop hidden renderer delivery after model ingestion; reveal restores a snapshot, while sidecar interest keeps raw bytes flowing. */
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { HIDDEN_OUTPUT_ACTIVITY_NOTICE_INTERVAL_MS } from '../../../../shared/terminal/replay/pty-model-restore-marker'
import { _resetPtyEscapeBoundaryForTest, clearPtyEscapeBoundary } from './pty-escape-boundary'

export type HiddenPtyDeliveryGateSettings = Pick<
  GlobalSettings,
  'terminalMainSideEffectAuthority' | 'terminalHiddenDeliveryGate'
>

const hiddenRendererPtys = new Set<string>()
// Sidecar consumers need live bytes even without a visible terminal view.
const deliveryInterestRendererPtys = new Set<string>()
// Keep drop memory until painted-restore ACK or teardown; reveal markers may reach no handler.
// Drops after reveal start a new episode so an older snapshot ACK cannot retire a newer gap.
const droppedSinceHiddenPtys = new Map<
  string,
  { state: 'unrevealed' | 'awaiting-paint'; episode: number }
>()
let nextHiddenDropEpisode = 1
// Runtime spawns have no view to re-mark them after reload; retain their mark until visible mount or teardown.
const runtimeOwnedHiddenRendererPtys = new Set<string>()
// A pane's own hidden claim outranks its visible report; only its release may reveal the PTY.
const rendererClaimedHiddenPtys = new Set<string>()
const rendererRetainingGraphicsPtys = new Set<string>()
// A visible report already sent this episode's 'unhide'; the pane's follow-up release must not resend it mid-restore.
const visibleReportUnhideEpisodes = new Map<string, number>()

// Hidden bytes never reach the renderer, so its agent-exit watch learns about output only from this throttled notice.
const lastHiddenOutputActivityNoticeAt = new Map<string, number>()

let droppedHiddenDeliveryChars = 0
let droppedHiddenDeliveryChunks = 0

export function isHiddenPtyDeliveryGateEnabled(
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): boolean {
  return (
    settings?.terminalMainSideEffectAuthority !== false &&
    settings?.terminalHiddenDeliveryGate !== false
  )
}

/** Re-marking must preserve drop memory across hidden remounts and renderer reloads. */
export function markHiddenRendererPty(id: string): void {
  hiddenRendererPtys.add(id)
}

/** Reveal reads the latch without retiring it: the marker may reach no handler. */
export function unmarkHiddenRendererPty(id: string): {
  droppedWhileHidden: boolean
  hiddenDropEpisode?: number
} {
  hiddenRendererPtys.delete(id)
  lastHiddenOutputActivityNoticeAt.delete(id)
  runtimeOwnedHiddenRendererPtys.delete(id)
  const latch = droppedSinceHiddenPtys.get(id)
  if (!latch) {
    return { droppedWhileHidden: false }
  }
  latch.state = 'awaiting-paint'
  return { droppedWhileHidden: true, hiddenDropEpisode: latch.episode }
}

/** Only a painted-restore ACK for the revealed episode can retire its drop memory. */
export function consumeHiddenRendererPtyDropMemory(id: string, hiddenDropEpisode?: number): void {
  const latch = droppedSinceHiddenPtys.get(id)
  if (latch?.state === 'awaiting-paint' && latch.episode === hiddenDropEpisode) {
    droppedSinceHiddenPtys.delete(id)
  }
}

export function isHiddenRendererPty(id: string): boolean {
  return hiddenRendererPtys.has(id)
}

export function markRuntimeOwnedHiddenRendererPty(id: string): void {
  hiddenRendererPtys.add(id)
  runtimeOwnedHiddenRendererPtys.add(id)
}

export function isRuntimeOwnedHiddenRendererPty(id: string): boolean {
  return runtimeOwnedHiddenRendererPtys.has(id)
}

export function setRendererHiddenClaim(id: string, hidden: boolean, retainGraphics = false): void {
  if (hidden && retainGraphics) {
    rendererRetainingGraphicsPtys.add(id)
  } else {
    rendererRetainingGraphicsPtys.delete(id)
  }
  if (hidden) {
    rendererClaimedHiddenPtys.add(id)
  } else {
    rendererClaimedHiddenPtys.delete(id)
  }
}

export function isRendererRetainingGraphics(id: string): boolean {
  return rendererRetainingGraphicsPtys.has(id)
}

/** A visible view reveals a runtime mark unless its renderer still claims the PTY hidden. */
export function shouldVisibleViewRevealHiddenRendererPty(id: string): boolean {
  return runtimeOwnedHiddenRendererPtys.has(id) && !rendererClaimedHiddenPtys.has(id)
}

export function recordVisibleReportUnhideEpisode(id: string, episode: number): void {
  visibleReportUnhideEpisodes.set(id, episode)
}

export function takeVisibleReportUnhideEpisode(id: string): number | undefined {
  const episode = visibleReportUnhideEpisodes.get(id)
  visibleReportUnhideEpisodes.delete(id)
  return episode
}

/** Include hidden PTYs in diagnostics even when all bytes were dropped before send accounting. */
export function getHiddenRendererPtyIds(): string[] {
  return [...hiddenRendererPtys]
}

/** Renderer-side ref-counted interest, surfaced as boolean transitions. */
export function setRendererPtyDeliveryInterest(id: string, interested: boolean): void {
  if (interested) {
    deliveryInterestRendererPtys.add(id)
  } else {
    deliveryInterestRendererPtys.delete(id)
  }
}

export function shouldDropHiddenRendererPtyData(
  id: string,
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): boolean {
  return (
    isHiddenPtyDeliveryGateEnabled(settings) &&
    hiddenRendererPtys.has(id) &&
    !rendererRetainingGraphicsPtys.has(id) &&
    !deliveryInterestRendererPtys.has(id)
  )
}

/** Request a restore marker on the first drop after retirement or reveal. */
export function recordHiddenRendererPtyDataDrop(
  id: string,
  chars: number,
  printed = chars > 0
): {
  shouldEmitRestoreMarker: boolean
  hiddenDropEpisode: number
  shouldEmitActivityNotice: boolean
} {
  droppedHiddenDeliveryChars += chars
  droppedHiddenDeliveryChunks += 1
  const now = Date.now()
  const lastNoticeAt = lastHiddenOutputActivityNoticeAt.get(id)
  // Leading edge: the first output after a quiet spell is reported at once.
  const shouldEmitActivityNotice =
    printed &&
    (lastNoticeAt === undefined || now - lastNoticeAt >= HIDDEN_OUTPUT_ACTIVITY_NOTICE_INTERVAL_MS)
  if (shouldEmitActivityNotice) {
    lastHiddenOutputActivityNoticeAt.set(id, now)
  }
  const latch = droppedSinceHiddenPtys.get(id)
  if (latch?.state === 'unrevealed') {
    return {
      shouldEmitRestoreMarker: false,
      hiddenDropEpisode: latch.episode,
      shouldEmitActivityNotice
    }
  }
  const episode = nextHiddenDropEpisode++
  droppedSinceHiddenPtys.set(id, { state: 'unrevealed', episode })
  return { shouldEmitRestoreMarker: true, hiddenDropEpisode: episode, shouldEmitActivityNotice }
}

/** Records a dropped pending entry; a byte-cap sentinel carries no data yet stands for output the PTY printed. */
export function recordHiddenPendingPtyDataDrop(
  id: string,
  pending: { data: string; droppedOutput?: true }
): ReturnType<typeof recordHiddenRendererPtyDataDrop> {
  const chars = pending.data.length
  return recordHiddenRendererPtyDataDrop(id, chars, chars > 0 || pending.droppedOutput === true)
}

export function hiddenRendererPtyDropEpisode(id: string): number | undefined {
  return droppedSinceHiddenPtys.get(id)?.episode
}

/** Reload clears renderer-owned marks/interest; runtime marks and unrestored drop episodes must survive. */
export function resetRendererScopedHiddenPtyDeliveryState(): void {
  hiddenRendererPtys.clear()
  lastHiddenOutputActivityNoticeAt.clear()
  deliveryInterestRendererPtys.clear()
  rendererClaimedHiddenPtys.clear()
  rendererRetainingGraphicsPtys.clear()
  visibleReportUnhideEpisodes.clear()
  for (const id of runtimeOwnedHiddenRendererPtys) {
    hiddenRendererPtys.add(id)
  }
}

export function clearHiddenRendererPtyDeliveryState(id: string): void {
  hiddenRendererPtys.delete(id)
  lastHiddenOutputActivityNoticeAt.delete(id)
  runtimeOwnedHiddenRendererPtys.delete(id)
  rendererClaimedHiddenPtys.delete(id)
  rendererRetainingGraphicsPtys.delete(id)
  visibleReportUnhideEpisodes.delete(id)
  deliveryInterestRendererPtys.delete(id)
  droppedSinceHiddenPtys.delete(id)
  clearPtyEscapeBoundary(id)
}

export type HiddenRendererPtyDeliveryDebug = {
  hiddenDeliveryGatedPtyCount: number
  deliveryInterestPtyCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryDroppedChunks: number
}

export function getHiddenRendererPtyDeliveryDebug(): HiddenRendererPtyDeliveryDebug {
  return {
    hiddenDeliveryGatedPtyCount: hiddenRendererPtys.size,
    deliveryInterestPtyCount: deliveryInterestRendererPtys.size,
    hiddenDeliveryDroppedChars: droppedHiddenDeliveryChars,
    hiddenDeliveryDroppedChunks: droppedHiddenDeliveryChunks
  }
}

export function resetHiddenRendererPtyDeliveryDebugCounters(): void {
  droppedHiddenDeliveryChars = 0
  droppedHiddenDeliveryChunks = 0
}

export function _resetHiddenRendererPtyDeliveryGateForTest(): void {
  hiddenRendererPtys.clear()
  runtimeOwnedHiddenRendererPtys.clear()
  rendererClaimedHiddenPtys.clear()
  rendererRetainingGraphicsPtys.clear()
  visibleReportUnhideEpisodes.clear()
  deliveryInterestRendererPtys.clear()
  droppedSinceHiddenPtys.clear()
  _resetPtyEscapeBoundaryForTest()
  resetHiddenRendererPtyDeliveryDebugCounters()
}
