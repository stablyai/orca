import type {
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'

const MAX_RETIRED_TERMINAL_SURFACE_PROOFS = 64

export function preserveTerminalRetirementProofs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  if (
    !existing?.retiredTerminalSurfaces?.length ||
    existing.worktree !== snapshot.worktree ||
    (existing.worktreeInstanceId !== undefined &&
      snapshot.worktreeInstanceId !== undefined &&
      existing.worktreeInstanceId !== snapshot.worktreeInstanceId)
  ) {
    return snapshot
  }
  const liveSurfaces = new Set(
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [`${tab.parentTabId}\0${tab.leafId}`] : []
    )
  )
  const retiredTerminalSurfaces = appendRetiredTerminalSurfaceProofs(
    existing.retiredTerminalSurfaces,
    snapshot.retiredTerminalSurfaces ?? []
  ).filter((surface) => !liveSurfaces.has(`${surface.parentTabId}\0${surface.leafId}`))
  return { ...snapshot, retiredTerminalSurfaces }
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
