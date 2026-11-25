export function hostNewWorktreeSessionRoute(
  hostId: string,
  worktreeId: string,
  worktreeName: string,
  /** Host-reported create warning (e.g. the startup terminal failed to spawn). */
  warning?: string
): `/h/${string}/session/${string}?${string}` {
  const params = new URLSearchParams({ name: worktreeName, created: '1' })
  if (warning?.trim()) {
    params.set('warning', warning)
  }
  return `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(worktreeId)}?${params}`
}
