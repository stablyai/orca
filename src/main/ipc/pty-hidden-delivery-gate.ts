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
 *
 * DEFAULTED OFF (STA-4042). Dropping renderer-bound bytes makes the renderer's
 * xterm a second emulator fed a different stream than the model, and a gap
 * strands whatever state it interrupted — a swallowed `ESC[22m` leaves bold on
 * every later cell. The setting survives only as an emergency rollback and has
 * no settings UI, so it is an internal escape hatch, not a user choice.
 *
 * REMOVAL CONDITION: delete this module and its call sites once
 * `hiddenDeliveryDroppedChars` (already reported via
 * getHiddenRendererPtyDeliveryDebug, surfaced in the freeze diagnostics) has
 * stayed at zero across released versions — non-zero can only mean a profile
 * re-enabled the switch, since the default no longer drops. Deleting it also
 * has to unpick the query-authority coupling in
 * terminal-model-query-authority.ts, which ANDs this switch. Do NOT delete the
 * general restore pipeline with it: renderer backlog overflow and main's
 * pending-delivery cap discard bytes independently of this gate and still need
 * recovery.
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
// dropped. Doubles as the one-shot marker latch: the first gated drop emits a
// restore marker, and the latch is consumed only by unmark (which re-emits)
// or full PTY teardown — never by re-marking hidden, so drop memory survives
// hidden remounts and renderer reloads.
const droppedSinceHiddenPtys = new Set<string>()

let droppedHiddenDeliveryChars = 0
let droppedHiddenDeliveryChunks = 0

/** Gate kill switches, both read main-side: the gate only operates under main
 *  side-effect authority AND the gate-specific setting. The gate-specific one
 *  now defaults OFF — dropping renderer-bound bytes desynchronizes the
 *  renderer's emulator from the model (STA-4042). */
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
}

/** Clears the hidden bit. Returns whether bytes were dropped while hidden so
 *  the caller can emit a restore marker to the now-visible renderer. */
export function unmarkHiddenRendererPty(id: string): { droppedWhileHidden: boolean } {
  hiddenRendererPtys.delete(id)
  const droppedWhileHidden = droppedSinceHiddenPtys.delete(id)
  return { droppedWhileHidden }
}

export function isHiddenRendererPty(id: string): boolean {
  return hiddenRendererPtys.has(id)
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
 *  force-feed) PTYs no live renderer party asked about. Drop memory is
 *  preserved — surviving daemon/SSH PTYs may have dropped bytes the old
 *  renderer never restored; the new renderer's first hidden/visible sync
 *  re-marks or unmarks and the unmark path re-emits the restore marker. */
export function resetRendererScopedHiddenPtyDeliveryState(): void {
  hiddenRendererPtys.clear()
  deliveryInterestRendererPtys.clear()
}

/** Full per-PTY teardown — wired into clearProviderPtyState so every exit
 *  path (local, daemon, SSH, connection teardown) releases gate state. */
export function clearHiddenRendererPtyDeliveryState(id: string): void {
  hiddenRendererPtys.delete(id)
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
  deliveryInterestRendererPtys.clear()
  droppedSinceHiddenPtys.clear()
  resetHiddenRendererPtyDeliveryDebugCounters()
}
