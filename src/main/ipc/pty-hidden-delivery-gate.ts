/**
 * Main-side hidden-delivery gate for renderer PTY byte delivery (Phase 4 of
 * the terminal model/view architecture).
 *
 * The renderer marks a PTY hidden when no visible view consumes its bytes;
 * main then drops renderer-bound delivery AFTER model ingestion — the runtime
 * already parsed the chunk, and reveal restores from the model snapshot via
 * the existing seq-guarded machinery. Any renderer party that still needs raw
 * bytes (dispatcher sidecars) registers delivery interest; main then sends that
 * PTY's hidden bytes for sidecars only, and the view stays gated.
 */
import type { GlobalSettings } from '../../shared/global-settings-types'

export type HiddenPtyDeliveryGateSettings = Pick<
  GlobalSettings,
  'terminalMainSideEffectAuthority' | 'terminalHiddenDeliveryGate'
>

const hiddenRendererPtys = new Set<string>()
// Why: sidecar consumers (paste-draft pacing, background agent launches,
// automation observers) need live bytes even while no visible view exists. Any
// registered interest turns drops for that PTY into sidecar-only delivery.
const deliveryInterestRendererPtys = new Set<string>()
// Why: reveal must restore from the model only when bytes were actually
// dropped. Doubles as the one-shot marker latch: the first gated drop emits a
// restore marker, and the latch is consumed only by unmark (which re-emits)
// or full PTY teardown — never by re-marking hidden, so drop memory survives
// hidden remounts and renderer reloads.
const droppedSinceHiddenPtys = new Set<string>()
// Why: a runtime background spawn has no renderer party to re-mark it after a
// reload/crash, so its hidden mark must outlive renderer-scoped resets until a
// renderer unmarks it (visible mount) or the PTY is torn down.
const runtimeOwnedHiddenRendererPtys = new Set<string>()

// Why: a PTY whose main model is being rebuilt from the daemon snapshot keeps feeding its
// renderer, which answers its queries, until the model has caught up with the stream.
const modelHandoffPtys = new Set<string>()
const hiddenMarkListeners = new Set<(id: string) => void>()
let modelHandoffChangeListener: ((id: string) => void) | null = null

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
 *  restore. Unmark is the only consumer of the latch. */
export function markHiddenRendererPty(id: string): void {
  hiddenRendererPtys.add(id)
  notifyHiddenMark(id)
}

/** Clears the hidden bit. Returns whether bytes were dropped while hidden so
 *  the caller can emit a restore marker to the now-visible renderer. */
export function unmarkHiddenRendererPty(id: string): { droppedWhileHidden: boolean } {
  hiddenRendererPtys.delete(id)
  runtimeOwnedHiddenRendererPtys.delete(id)
  const droppedWhileHidden = droppedSinceHiddenPtys.delete(id)
  return { droppedWhileHidden }
}

export function isHiddenRendererPty(id: string): boolean {
  return hiddenRendererPtys.has(id)
}

/** Marks a PTY hidden on behalf of the runtime (no renderer view exists). */
export function markRuntimeOwnedHiddenRendererPty(id: string): void {
  hiddenRendererPtys.add(id)
  runtimeOwnedHiddenRendererPtys.add(id)
  notifyHiddenMark(id)
}

/** Runs synchronously inside every hidden mark, before the caller reads droppability, so a
 *  listener that opens a model handoff keeps the PTY's bytes flowing from the first one. */
export function registerHiddenRendererPtyMarkListener(listener: (id: string) => void): void {
  hiddenMarkListeners.add(listener)
}

function notifyHiddenMark(id: string): void {
  for (const listener of hiddenMarkListeners) {
    listener(id)
  }
}

/** Suppresses the gate for `id` while main's model catches up with the stream. */
export function setHiddenDeliveryModelHandoff(id: string, pending: boolean): void {
  const changed = pending ? !modelHandoffPtys.has(id) : modelHandoffPtys.has(id)
  if (pending) {
    modelHandoffPtys.add(id)
  } else {
    modelHandoffPtys.delete(id)
  }
  if (changed) {
    modelHandoffChangeListener?.(id)
  }
}

/** Delivery re-evaluates queued bytes when a handoff ends and the gate starts dropping. */
export function setHiddenDeliveryModelHandoffChangeListener(
  listener: ((id: string) => void) | null
): void {
  modelHandoffChangeListener = listener
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

/** Hidden for the view whether or not a sidecar holds interest: the view restores
 *  from the model on reveal, so main owns the PTY's query replies meanwhile. */
export function isHiddenRendererPtyViewGated(
  id: string,
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): boolean {
  return (
    isHiddenPtyDeliveryGateEnabled(settings) &&
    hiddenRendererPtys.has(id) &&
    !modelHandoffPtys.has(id)
  )
}

/** How main delivers a PTY's bytes to the renderer; the one owner of that decision:
 *  - 'drop': hidden view, no sidecar wants the bytes; the view restores from the model on reveal.
 *  - 'sidecarsOnly': hidden view, sidecars still get the bytes; the view skips them.
 *  - 'parse': the view parses the bytes.
 *  Main's model owns a chunk's query replies unless its delivery is 'parse'. Delivery stamps
 *  each chunk with the mode it had at ingestion, so a later flip cannot move that ownership. */
export type RendererPtyViewDelivery = 'parse' | 'sidecarsOnly' | 'drop'

export function rendererPtyViewDelivery(
  id: string,
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): RendererPtyViewDelivery {
  if (isHiddenRendererPtyViewGated(id, settings)) {
    return deliveryInterestRendererPtys.has(id) ? 'sidecarsOnly' : 'drop'
  }
  return 'parse'
}

export function shouldDropHiddenRendererPtyData(
  id: string,
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): boolean {
  return rendererPtyViewDelivery(id, settings) === 'drop'
}

/** Hidden bytes still sent because a sidecar needs them, which the view must skip:
 *  the renderer credits them on receipt, so a throttled hidden view never paces the PTY. */
export function shouldDeliverHiddenRendererPtyDataToSidecarsOnly(
  id: string,
  settings: HiddenPtyDeliveryGateSettings | null | undefined
): boolean {
  return rendererPtyViewDelivery(id, settings) === 'sidecarsOnly'
}

/** Record one gated drop. Returns whether the caller should emit the one-shot
 *  empty restore-marker chunk (first drop since this PTY went hidden). */
export function recordHiddenRendererPtyDataDrop(
  id: string,
  chars: number
): { shouldEmitRestoreMarker: boolean } {
  droppedHiddenDeliveryChars += chars
  droppedHiddenDeliveryChunks += 1
  if (droppedSinceHiddenPtys.has(id)) {
    return { shouldEmitRestoreMarker: false }
  }
  droppedSinceHiddenPtys.add(id)
  return { shouldEmitRestoreMarker: true }
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
  modelHandoffPtys.delete(id)
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
  modelHandoffPtys.clear()
  hiddenMarkListeners.clear()
  modelHandoffChangeListener = null
  resetHiddenRendererPtyDeliveryDebugCounters()
}
