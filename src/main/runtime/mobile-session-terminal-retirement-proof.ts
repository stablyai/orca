import type { RuntimeMobileSessionRetiredTerminalSurface } from '../../shared/runtime-types'

const MAX_RETIRED_TERMINAL_SURFACE_PROOFS = 64

export function appendRetiredTerminalSurfaceProofs(
  existing: readonly RuntimeMobileSessionRetiredTerminalSurface[] | undefined,
  retired: readonly RuntimeMobileSessionRetiredTerminalSurface[]
): RuntimeMobileSessionRetiredTerminalSurface[] {
  const next = new Map(
    (existing ?? []).map((surface) => [
      `${surface.parentTabId}\0${surface.leafId}\0${surface.terminal}`,
      surface
    ])
  )
  for (const evidence of retired) {
    const key = `${evidence.parentTabId}\0${evidence.leafId}\0${evidence.terminal}`
    next.delete(key)
    next.set(key, evidence)
  }
  while (next.size > MAX_RETIRED_TERMINAL_SURFACE_PROOFS) {
    const oldest = next.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    next.delete(oldest)
  }
  return [...next.values()]
}
