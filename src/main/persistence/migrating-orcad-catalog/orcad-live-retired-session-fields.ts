export const isSessionEvidenceObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
export const identityFields = new Set([
  'id',
  'entityId',
  'parentTabId',
  'tabId',
  'groupId',
  'workspaceId',
  'browserPageId',
  'ptyId',
  'incarnationId',
  'activeTabId'
])
const arrayRowFields = new Set([
  'tabsByWorktree',
  'openFilesByWorktree',
  'browserTabsByWorktree',
  'clientHostedBrowserPagesByWorktree',
  'unifiedTabs',
  'tabGroups',
  'browserPagesByWorkspace'
])
const stringRowFields = new Set([
  'activeFileIdByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'activeGroupIdByWorktree',
  'remoteSessionIdsByTabId',
  'terminalPtyIncarnationsByPaneKey'
])

export function supportedRow(field: string, value: unknown): boolean {
  if (arrayRowFields.has(field)) {
    return Array.isArray(value) && value.every(isSessionEvidenceObject)
  }
  if (stringRowFields.has(field)) {
    return value === null || typeof value === 'string'
  }
  if (
    field === 'markdownFrontmatterVisible' ||
    field === 'defaultTerminalTabsAppliedByWorktreeId'
  ) {
    return typeof value === 'boolean'
  }
  if (field === 'lastVisitedAtByWorktreeId' || field === 'terminalTopologyRevisionByRepoId') {
    return typeof value === 'number' && Number.isFinite(value)
  }
  return isSessionEvidenceObject(value)
}

export function collectRemovedIdentities(value: unknown, identities: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRemovedIdentities(entry, identities))
  } else if (isSessionEvidenceObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (identityFields.has(key) && typeof entry === 'string') {
        identities.add(entry)
      }
      collectRemovedIdentities(entry, identities)
    }
  }
}

export function containsSourcePtyReference(
  value: unknown,
  sourcePtys: Set<string>,
  field = ''
): boolean {
  if (field === 'ptyId') {
    return typeof value === 'string' && sourcePtys.has(value)
  }
  if (field === 'ptyIdsByLeafId' || field === 'remoteSessionIdsByTabId') {
    return (
      value !== undefined &&
      (!isSessionEvidenceObject(value) ||
        Object.values(value).some((id) => typeof id !== 'string' || sourcePtys.has(id)))
    )
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSourcePtyReference(entry, sourcePtys))
  }
  return (
    isSessionEvidenceObject(value) &&
    Object.entries(value).some(([key, entry]) => containsSourcePtyReference(entry, sourcePtys, key))
  )
}
