/**
 * Keeps a released move's session frozen until the window reloads. While moved, the renderer holds
 * only the project's chat tabs; a save from that page would overwrite the pre-move session the
 * freeze preserved. After the reload the renderer hydrates the full session from disk.
 */
type HeldScope = { repoIds: Set<string>; folderWorkspaceIds: Set<string> }

let held: HeldScope | null = null

export function holdReleasedWslMoveSessions(scope: {
  repoIds: readonly string[]
  folderWorkspaceIds: readonly string[]
}): void {
  held ??= { repoIds: new Set(), folderWorkspaceIds: new Set() }
  for (const id of scope.repoIds) {
    held.repoIds.add(id)
  }
  for (const id of scope.folderWorkspaceIds) {
    held.folderWorkspaceIds.add(id)
  }
}

export function liftReleasedWslMoveSessionHolds(): void {
  held = null
}

export function hasReleasedWslMoveSessionHolds(): boolean {
  return held !== null
}

export function isReleasedWslMoveSessionHeld(
  ref: { repoId: string } | { folderWorkspaceId: string }
): boolean {
  if (!held) {
    return false
  }
  return 'repoId' in ref
    ? held.repoIds.has(ref.repoId)
    : held.folderWorkspaceIds.has(ref.folderWorkspaceId)
}
