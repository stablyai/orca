/** A save names the profile domains it changed; 'whole' only where a mutation cannot know them. */
export type ProfileSaveDomains = readonly string[] | 'whole'

export const WORKTREE_METADATA_DOMAINS = [
  'worktreeMeta',
  'worktreeMetaByIdentity',
  'worktreeIdentityAliases'
] as const

export const WORKSPACE_LINEAGE_DOMAINS = [
  'worktreeLineageById',
  'workspaceLineageByChildKey',
  'crossStoreLineageByChildKey'
] as const

/** Records that carry sort stamps and unread flags: worktree metadata and folder workspaces. */
export const WORKSPACE_RECORD_DOMAINS: readonly string[] = [
  ...WORKTREE_METADATA_DOMAINS,
  'folderWorkspaces'
]

/** Repo, project, folder, lineage and SSH catalog domains; listeners read these as a catalog change. */
export const WORKSPACE_CATALOG_SAVE_DOMAINS: readonly string[] = [
  'repos',
  'projects',
  'projectHostSetups',
  'projectGroups',
  'folderWorkspaces',
  'folderWorkspaceDiffComments',
  ...WORKSPACE_LINEAGE_DOMAINS,
  'sparsePresetsByRepo',
  'retiredWorktreeNamesByRepo',
  'retiredWorktreeNamesByNamespace',
  'sshTargets',
  'sshTargetGenerationCounter',
  'deletedSshConfigAliases',
  'removedSshTargetTombstones',
  'sshPtyConsumerRecoveries',
  'orcadMigrationStagedCatalogs'
]

/** Undefined means a whole save, which may have changed any catalog domain. */
export function savedWorkspaceCatalog(dirtyDomains: readonly string[] | undefined): boolean {
  return (
    dirtyDomains === undefined ||
    dirtyDomains.some((domain) => WORKSPACE_CATALOG_SAVE_DOMAINS.includes(domain))
  )
}
