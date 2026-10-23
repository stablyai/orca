import { NativeModule, requireOptionalNativeModule } from 'expo-modules-core'

/** A rect in window points, the root view's coordinates. */
export type ReservedRect = { x: number; y: number; width: number; height: number }

/** The window's active reserved regions: a partially folded iPhone Duo's fold, and its camera. */
export type ReservedRegions = { divisions: ReservedRect[]; occlusions: ReservedRect[] }

type ReservedRegionsEvents = {
  /** Sent once the module starts observing, then whenever the active regions change. */
  onChange: (regions: ReservedRegions) => void
}

declare class OrcaReservedRegionsModule extends NativeModule<ReservedRegionsEvents> {}

/**
 * Null on Android, the web and in a binary built before the module existed. A binary built with
 * an SDK older than iOS 27.1, or running on an older iOS, never sends `onChange`.
 */
export const OrcaReservedRegions =
  requireOptionalNativeModule<OrcaReservedRegionsModule>('OrcaReservedRegions')
