/**
 * Main-side hidden-delivery gate for renderer PTY byte delivery (Phase 4 of
 * the terminal model/view architecture).
 *
 * The renderer marks a PTY hidden when no visible view consumes its bytes;
 * main then drops renderer-bound delivery AFTER model ingestion — the runtime
 * already parsed the chunk, and reveal restores from the model snapshot via
 * the existing seq-guarded machinery. Any renderer party that still needs raw
 * bytes (dispatcher sidecars) registers delivery
 * interest, which suppresses the gate for that PTY.
 */
import type { GlobalSettings } from '../../shared/global-settings-types'

export type HiddenPtyDeliveryGateSettings = Pick<
  GlobalSettings,
  'terminalMainSideEffectAuthority' | 'terminalHiddenDeliveryGate'
>

const hiddenRendererPtys = new Set<string>()
// Why: sidecar consumers (paste-draft pacing, background agent launches,
// automation observers) need live bytes even while no visible view exists. Any
// registered interest suppresses the gate for that PTY.
const deliveryInterestRendererPtys = new Set<string>()
// Why: reveal must restore from the model only when bytes were actually
// dropped. Doubles as the marker latch: the first gated drop emits a restore
// marker and every unhide re-emits one. It retires only when the renderer acks
// the restore painted, or on PTY teardown — a retiring hidden pane unhides after
// unregistering its marker handler, so spending it on unhide loses the gap.
// 'awaiting-paint' = an unhide re-emitted the marker; a drop after that starts a
// new episode the in-flight restore's snapshot may predate, so its ack must not
// retire it.
const droppedSinceHiddenPtys = new Map<
  string,
  { state: 'unrevealed' | 'awaiting-paint'; episode: number }
>()
let nextHiddenDropEpisode = 1
// Why: a runtime background spawn has no renderer party to re-mark it after a
// reload/crash, so its hidden mark must outlive renderer-scoped resets until a
// renderer unmarks it (visible mount) or the PTY is torn down.
const runtimeOwnedHiddenRendererPtys = new Set<string>()

let droppedHiddenDeliveryChars = 0
let droppedHiddenDeliveryChunks = 0

/** Gate kill switches, both read main-side: the gate only operates under main
 *  side-effect authority AND the gate-specific setting (both default on). */
export function isHiddenPtyDeliveryGateEnabled(
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): boolean {
  return (
    settings?.terminalMainSideEffectAuthority !== false &&
    settings?.terminalHiddenDeliveryGate !== false
  )
}

/** Renderer-reported "no visible view needs bytes" bit. Never clears drop
 *  memory: a hidden remount or renderer reload re-marks an already-dropped
 *  PTY, and erasing the latch there would make the eventual reveal skip the
 *  restore. */
export function markHiddenRendererPty(id: string): void {
  hiddenRendererPtys.add(id)
}

/** Clears the hidden bit. Returns whether bytes were dropped while hidden so
 *  the caller can emit a restore marker. Reads the latch without spending it:
 *  the marker may reach no handler (see droppedSinceHiddenPtys). */
export function unmarkHiddenRendererPty(id: string): {
  droppedWhileHidden: boolean
  hiddenDropEpisode?: number
} {
  hiddenRendererPtys.delete(id)
  runtimeOwnedHiddenRendererPtys.delete(id)
  const latch = droppedSinceHiddenPtys.get(id)
  if (!latch) {
    return { droppedWhileHidden: false }
  }
  latch.state = 'awaiting-paint'
  return { droppedWhileHidden: true, hiddenDropEpisode: latch.episode }
}

/** Retires drop memory once the renderer reports painting a restore requested
 *  for this episode. An older restore's ack must not retire a newer episode,
 *  and an ack naming no episode retires nothing (fails toward recovery). */
export function consumeHiddenRendererPtyDropMemory(id: string, hiddenDropEpisode?: number): void {
  const latch = droppedSinceHiddenPtys.get(id)
  if (latch?.state === 'awaiting-paint' && latch.episode === hiddenDropEpisode) {
    droppedSinceHiddenPtys.delete(id)
  }
}

export function isHiddenRendererPty(id: string): boolean {
  return hiddenRendererPtys.has(id)
}

/** Marks a PTY hidden on behalf of the runtime (no renderer view exists). */
export function markRuntimeOwnedHiddenRendererPty(id: string): void {
  hiddenRendererPtys.add(id)
  runtimeOwnedHiddenRendererPtys.add(id)
}

export function isRuntimeOwnedHiddenRendererPty(id: string): boolean {
  return runtimeOwnedHiddenRendererPtys.has(id)
}

/** For freeze diagnostics only: hidden ptys must appear in the per-pty report
 *  table even when the gate dropped every byte before any send/accounting. */
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
    !deliveryInterestRendererPtys.has(id)
  )
}

/** Record one gated drop. Returns whether the caller should emit the one-shot
 *  empty restore-marker chunk (first drop since the latch was retired or last revealed). */
export function recordHiddenRendererPtyDataDrop(
  id: string,
  chars: number
): { shouldEmitRestoreMarker: boolean; hiddenDropEpisode: number } {
  droppedHiddenDeliveryChars += chars
  droppedHiddenDeliveryChunks += 1
  const latch = droppedSinceHiddenPtys.get(id)
  if (latch?.state === 'unrevealed') {
    return { shouldEmitRestoreMarker: false, hiddenDropEpisode: latch.episode }
  }
  const episode = nextHiddenDropEpisode++
  droppedSinceHiddenPtys.set(id, { state: 'unrevealed', episode })
  return { shouldEmitRestoreMarker: true, hiddenDropEpisode: episode }
}

/** The open drop episode, if bytes were dropped since the last restore painted. */
export function hiddenRendererPtyDropEpisode(id: string): number | undefined {
  return droppedSinceHiddenPtys.get(id)?.episode
}

/** Renderer process replaced (reload / crash): its ref-counted interest
 *  holds and hidden marks died with it, so keeping them would gate (or
 *  force-feed) PTYs no live renderer party asked about. Runtime-owned marks
 *  survive: no renderer party exists to re-mark them. Drop memory is
 *  preserved — surviving daemon/SSH PTYs may have dropped bytes the old
 *  renderer never restored; the new renderer's first hidden/visible sync
 *  re-marks or unmarks and the unmark path re-emits the restore marker. */
export function resetRendererScopedHiddenPtyDeliveryState(): void {
  hiddenRendererPtys.clear()
  deliveryInterestRendererPtys.clear()
  for (const id of runtimeOwnedHiddenRendererPtys) {
    hiddenRendererPtys.add(id)
  }
}

/** Full per-PTY teardown — wired into clearProviderPtyState so every exit
 *  path (local, daemon, SSH, connection teardown) releases gate state. */
export function clearHiddenRendererPtyDeliveryState(id: string): void {
  hiddenRendererPtys.delete(id)
  runtimeOwnedHiddenRendererPtys.delete(id)
  deliveryInterestRendererPtys.delete(id)
  droppedSinceHiddenPtys.delete(id)
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

/** Test seam: reset all module state between tests. */
export function _resetHiddenRendererPtyDeliveryGateForTest(): void {
  hiddenRendererPtys.clear()
  runtimeOwnedHiddenRendererPtys.clear()
  deliveryInterestRendererPtys.clear()
  droppedSinceHiddenPtys.clear()
  resetHiddenRendererPtyDeliveryDebugCounters()
}
