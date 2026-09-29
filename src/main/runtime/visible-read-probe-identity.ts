export type VisibleReadProbeIdentity = Readonly<{
  ptyId: string
  rendererGraphEpoch: number | null
  ptyGeneration: number | null
  lifecycleGeneration: number
  /** Informational only: provider snapshot reads carry their own output watermark. */
  outputSequence?: number
}>

/**
 * Provider snapshots carry their own output watermark. Output arriving while a read is in flight
 * therefore does not invalidate an otherwise current identity; a handle or process replacement does.
 */
export function isVisibleReadProbeIdentityCurrent(
  captured: VisibleReadProbeIdentity,
  current: VisibleReadProbeIdentity,
  waiterRegistered: boolean
): boolean {
  return (
    waiterRegistered &&
    captured.ptyId === current.ptyId &&
    captured.rendererGraphEpoch === current.rendererGraphEpoch &&
    captured.ptyGeneration === current.ptyGeneration &&
    captured.lifecycleGeneration === current.lifecycleGeneration
  )
}
