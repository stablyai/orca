/** List source-path locations and deliberate exceptions for export rewriting. */

/** Rewrite absolute/maybe-absolute values only when absolute; relative paths stay relative and URLs change only for file:. */
export type OrcadMigrationPathForm = 'absolute' | 'maybe-absolute' | 'relative' | 'url'

/** Rebuild composite ids only when their embedded path changes. */
type CompositeKind =
  /** `<repoId>::<path>`, optionally `::workspace:<uuid>` for a folder project. */
  | 'worktree-id'
  /** A worktree id, `worktree:<worktreeId>` or `folder:<id>`. */
  | 'owner-key'
  /** `<owner key>@@<id>` when minted by Orca; anything else is opaque. */
  | 'pty-session-id'
  /** `editor:<enc worktreeId>:<enc runtime>:<enc filePath>`, a raw absolute path, or an opaque id. */
  | 'editor-file-id'

export type OrcadMigrationPathFieldKind = OrcadMigrationPathForm | CompositeKind

/** Locations use . for properties, [] for items, {} for values and final {key} for keys; leave missing/null values alone. */
export const ORCAD_MIGRATION_PATH_FIELDS: readonly {
  at: string
  kind: OrcadMigrationPathFieldKind
}[] = [
  { at: 'repositories[].path', kind: 'absolute' },
  { at: 'repositories[].folderUpgradeGitRootPath', kind: 'absolute' },
  { at: 'repositories[].worktreeBasePath', kind: 'maybe-absolute' },
  { at: 'repositories[].externalWorktreeInboxBaselinePaths[]', kind: 'absolute' },
  { at: 'repositories[].importedExternalWorktreePaths[]', kind: 'absolute' },
  { at: 'repositories[].symlinkPaths[]', kind: 'relative' },
  { at: 'repositories[].customWorktreeVisibilitySources[].rootPath', kind: 'absolute' },
  { at: 'projectGroups[].parentPath', kind: 'absolute' },
  { at: 'folderWorkspaces[].folderPath', kind: 'absolute' },
  { at: 'folderWorkspaces[].diffComments[].worktreeId', kind: 'worktree-id' },
  { at: 'folderWorkspaces[].diffComments[].filePath', kind: 'relative' },
  { at: 'folderWorkspaces[].diffComments[].oldPath', kind: 'relative' },

  { at: 'dormantState.worktreeMeta[].worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.worktreeMeta[].meta.priorWorktreeIds[]', kind: 'worktree-id' },
  { at: 'dormantState.worktreeMeta[].meta.sparseDirectories[]', kind: 'relative' },
  { at: 'dormantState.worktreeMeta[].meta.diffComments[].worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.worktreeMeta[].meta.diffComments[].filePath', kind: 'relative' },
  { at: 'dormantState.worktreeMeta[].meta.diffComments[].oldPath', kind: 'relative' },
  { at: 'dormantState.worktreeMeta[].meta.mobileDiffReview.files{}.filePath', kind: 'relative' },
  { at: 'dormantState.worktreeMeta[].meta.mobileDiffReview.files{}.oldPath', kind: 'relative' },
  { at: 'dormantState.worktreeLineage[].worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.worktreeLineage[].lineage.worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.worktreeLineage[].lineage.parentWorktreeId', kind: 'worktree-id' },
  { at: 'dormantState.workspaceLineage[].childWorkspaceKey', kind: 'owner-key' },
  { at: 'dormantState.workspaceLineage[].lineage.childWorkspaceKey', kind: 'owner-key' },
  { at: 'dormantState.workspaceLineage[].lineage.parentWorkspaceKey', kind: 'owner-key' },

  { at: 'dormantState.workspaceSession.activeWorktreeId', kind: 'worktree-id' },
  { at: 'dormantState.workspaceSession.activeWorkspaceKey', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.tabsByWorktree{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.tabsByWorktree{}[].worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.workspaceSession.tabsByWorktree{}[].startupCwd', kind: 'absolute' },
  { at: 'dormantState.workspaceSession.tabsByWorktree{}[].ptyId', kind: 'pty-session-id' },
  { at: 'dormantState.workspaceSession.activeWorktreeIdsOnShutdown[]', kind: 'worktree-id' },
  { at: 'dormantState.workspaceSession.openFilesByWorktree{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.openFilesByWorktree{}[].filePath', kind: 'absolute' },
  { at: 'dormantState.workspaceSession.openFilesByWorktree{}[].relativePath', kind: 'relative' },
  { at: 'dormantState.workspaceSession.openFilesByWorktree{}[].worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.workspaceSession.activeFileIdByWorktree{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.activeFileIdByWorktree{}', kind: 'editor-file-id' },
  { at: 'dormantState.workspaceSession.markdownFrontmatterVisible{key}', kind: 'editor-file-id' },
  { at: 'dormantState.workspaceSession.browserTabsByWorktree{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.browserTabsByWorktree{}[].worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.workspaceSession.browserTabsByWorktree{}[].url', kind: 'url' },
  {
    at: 'dormantState.workspaceSession.browserTabsByWorktree{}[].docLocation.worktreeId',
    kind: 'worktree-id'
  },
  {
    at: 'dormantState.workspaceSession.browserTabsByWorktree{}[].docLocation.filePath',
    kind: 'absolute'
  },
  {
    at: 'dormantState.workspaceSession.browserPagesByWorkspace{}[].worktreeId',
    kind: 'worktree-id'
  },
  { at: 'dormantState.workspaceSession.browserPagesByWorkspace{}[].url', kind: 'url' },
  ...docLocationFields('dormantState.workspaceSession.browserPagesByWorkspace{}[].docLocation'),
  ...conversionOriginFields(
    'dormantState.workspaceSession.browserPagesByWorkspace{}[].convertedFrom'
  ),
  ...conversionOriginFields(
    'dormantState.workspaceSession.browserPagesByWorkspace{}[].convertedTo'
  ),
  { at: 'dormantState.workspaceSession.activeBrowserTabIdByWorktree{key}', kind: 'owner-key' },
  {
    at: 'dormantState.workspaceSession.clientHostedBrowserPagesByWorktree{key}',
    kind: 'owner-key'
  },
  {
    at: 'dormantState.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment{}[].worktreeId',
    kind: 'worktree-id'
  },
  { at: 'dormantState.workspaceSession.activeTabTypeByWorktree{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.browserUrlHistory[].url', kind: 'url' },
  ...docLocationFields('dormantState.workspaceSession.workspaceDocHistory[].docLocation'),
  { at: 'dormantState.workspaceSession.activeTabIdByWorktree{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.unifiedTabs{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.unifiedTabs{}[].id', kind: 'editor-file-id' },
  { at: 'dormantState.workspaceSession.unifiedTabs{}[].entityId', kind: 'editor-file-id' },
  { at: 'dormantState.workspaceSession.unifiedTabs{}[].worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.workspaceSession.tabGroups{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.tabGroups{}[].worktreeId', kind: 'worktree-id' },
  { at: 'dormantState.workspaceSession.tabGroups{}[].activeTabId', kind: 'editor-file-id' },
  { at: 'dormantState.workspaceSession.tabGroups{}[].tabOrder[]', kind: 'editor-file-id' },
  { at: 'dormantState.workspaceSession.tabGroups{}[].recentTabIds[]', kind: 'editor-file-id' },
  { at: 'dormantState.workspaceSession.tabGroupLayouts{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.activeGroupIdByWorktree{key}', kind: 'owner-key' },
  { at: 'dormantState.workspaceSession.lastVisitedAtByWorktreeId{key}', kind: 'owner-key' },
  {
    at: 'dormantState.workspaceSession.defaultTerminalTabsAppliedByWorktreeId{key}',
    kind: 'owner-key'
  },
  {
    at: 'dormantState.workspaceSession.sleepingAgentSessionsByPaneKey{}.worktreeId',
    kind: 'worktree-id'
  },
  {
    at: 'dormantState.workspaceSession.sleepingAgentSessionsByPaneKey{}.providerSession.transcriptPath',
    kind: 'absolute'
  },
  {
    at: 'dormantState.workspaceSession.sleepingAgentSessionsByPaneKey{}.providerSession.cwd',
    kind: 'absolute'
  },
  {
    at: 'dormantState.workspaceSession.sleepingAgentSessionsByPaneKey{}.launchConfig.ompResumeFilePath',
    kind: 'absolute'
  },
  {
    at: 'dormantState.workspaceSession.terminalSurfaceTombstonesByPaneKey{}.worktreeId',
    kind: 'worktree-id'
  },
  {
    at: 'dormantState.workspaceSession.terminalSurfaceTombstonesByPaneKey{}.ptyId',
    kind: 'pty-session-id'
  },
  {
    at: 'dormantState.workspaceSession.closedTerminalTabTombstonesByTabId{}.worktreeId',
    kind: 'worktree-id'
  },

  { at: 'dormantState.automations[].workspaceId', kind: 'owner-key' },
  { at: 'dormantState.automations[].runContext.path', kind: 'absolute' },
  { at: 'dormantState.automationRuns[].workspaceId', kind: 'owner-key' },
  { at: 'dormantState.automationRuns[].runContext.path', kind: 'absolute' },
  { at: 'dormantState.automationRuns[].terminalPtyId', kind: 'pty-session-id' },
  { at: 'dormantState.automationRuns[].terminalSessionId', kind: 'pty-session-id' },

  {
    at: 'dormantState.clientState.mobileClientTabSelectionsByDeviceId{}{key}',
    kind: 'owner-key'
  },
  {
    at: 'dormantState.clientState.mobileClientTabSelectionsByDeviceId{}{}.activeTabId',
    kind: 'editor-file-id'
  },
  {
    at: 'dormantState.clientState.mobileClientTabSelectionsByDeviceId{}{}.activeTabIdByGroupId{}',
    kind: 'editor-file-id'
  },
  {
    at: 'dormantState.clientState.mobileClientTabSelectionsByDeviceId{}{}.recentTabIds[]',
    kind: 'editor-file-id'
  },
  { at: 'dormantState.clientState.uiRouting.lastActiveWorktreeId', kind: 'worktree-id' },
  { at: 'dormantState.clientState.uiRouting.showDotfilesByWorktree{key}', kind: 'owner-key' },
  {
    at: 'dormantState.clientState.clientHostedBrowserCloseIntents[].worktreeId',
    kind: 'worktree-id'
  }
]

/** Keep source keys for post-commit subtraction; recompute derived keys instead of mapping their strings. */
export const ORCAD_MIGRATION_UNREWRITTEN_PATH_FIELDS: readonly { at: string; why: string }[] = [
  { at: 'dormantState.worktreeMeta[].sourceKey', why: 'source-side key' },
  { at: 'dormantState.worktreeLineage[].sourceKey', why: 'source-side key' },
  { at: 'dormantState.workspaceLineage[].sourceKey', why: 'source-side key' },
  { at: 'dormantState.retiredWorktreeNamespaces[].sourceNamespaceKeys[]', why: 'source-side key' },
  {
    at: 'dormantState.retiredWorktreeNamespaces[].namespaceKey',
    why: 'normalized comparison key: recompute for the destination host'
  },
  {
    at: 'dormantState.worktreeMeta[].meta.mobileDiffReview.files{key}',
    why: 'relative paths only'
  },
  { at: 'repositories[].repoIcon.label', why: 'relative path only' },
  {
    at: 'dormantState.workspaceSession.sleepingAgentSessionsByPaneKey{}.launchConfig.agentEnv{}',
    why: 'free-form'
  },
  { at: 'repositories[].hookSettings', why: 'free-form shell text' },
  { at: 'repositories[].gitRemoteIdentity.remoteUrl', why: 'git remote URL' }
]

function docLocationFields(at: string): { at: string; kind: OrcadMigrationPathFieldKind }[] {
  return [
    { at: `${at}.worktreeId`, kind: 'worktree-id' },
    { at: `${at}.filePath`, kind: 'absolute' }
  ]
}

function conversionOriginFields(at: string): { at: string; kind: OrcadMigrationPathFieldKind }[] {
  return [...docLocationFields(`${at}.docLocation`), { at: `${at}.url`, kind: 'url' }]
}
