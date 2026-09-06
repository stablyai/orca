import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

const MAX_RETIRED_TERMINAL_SURFACE_PROOFS = 64

const surfaceKey = (surface: { parentTabId: string; leafId: string }): string =>
  `${surface.parentTabId}\0${surface.leafId}`

/** A surface published again is no longer retired, whatever handle now occupies it. */
export function dropRetirementProofsForLiveSurfaces(
  retired: readonly RuntimeMobileSessionRetiredTerminalSurface[],
  tabs: readonly RuntimeMobileSessionSnapshotTab[]
): RuntimeMobileSessionRetiredTerminalSurface[] {
  const live = new Set(tabs.flatMap((tab) => (tab.type === 'terminal' ? [surfaceKey(tab)] : [])))
  return retired.filter((surface) => !live.has(surfaceKey(surface)))
}

/** Renderer snapshots omit the host's durable close acknowledgements; carry them forward. */
export function preserveTerminalRetirementProofs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  if (
    !existing?.retiredTerminalSurfaces?.length ||
    existing.worktree !== snapshot.worktree ||
    // Fence on instance identity only when both sides know it: host-authored snapshots never set it.
    (existing.worktreeInstanceId !== undefined &&
      snapshot.worktreeInstanceId !== undefined &&
      existing.worktreeInstanceId !== snapshot.worktreeInstanceId)
  ) {
    return snapshot
  }
  return {
    ...snapshot,
    retiredTerminalSurfaces: dropRetirementProofsForLiveSurfaces(
      appendRetiredTerminalSurfaceProofs(
        existing.retiredTerminalSurfaces,
        snapshot.retiredTerminalSurfaces ?? []
      ),
      snapshot.tabs
    )
  }
}

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
