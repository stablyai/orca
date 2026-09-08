/** Strips the placeholder identity a shared page projection carries, so the wrapper result never
 * asserts a workspace handle the Desktop does not own. */
export function withoutMobileWebWorkspaceId<T extends { workspaceId: string }>(
  value: T
): Omit<T, 'workspaceId'> {
  const { workspaceId: _workspaceId, ...rest } = value
  return rest
}
