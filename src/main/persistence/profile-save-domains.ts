import { WORKSPACE_SESSION_DOMAINS } from './workspace-session-domains'

/** The profile domains a mutation changed; its save writes only their rows. */
export type ProfileSaveDomains = readonly string[]

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

/** Repo writes also re-derive the project catalog compatibility rows. */
export const REPO_CATALOG_DOMAINS: readonly string[] = ['repos', 'projects', 'projectHostSetups']

/** Removing a project prunes its workspaces' metadata, lineage, sessions and phone selections. */
export const REMOVE_PROJECT_DOMAINS: readonly string[] = [
  ...REPO_CATALOG_DOMAINS,
  'sparsePresetsByRepo',
  'retiredWorktreeNamesByRepo',
  ...WORKTREE_METADATA_DOMAINS,
  ...WORKSPACE_LINEAGE_DOMAINS,
  ...WORKSPACE_SESSION_DOMAINS,
  'mobileClientTabSelectionsByDeviceId',
  'scheduledMessages'
]

/** Removing a folder workspace drops its sessions, lineage and phone selections. */
export const FOLDER_WORKSPACE_REMOVAL_DOMAINS: readonly string[] = [
  'folderWorkspaces',
  'workspaceLineageByChildKey',
  'crossStoreLineageByChildKey',
  ...WORKSPACE_SESSION_DOMAINS,
  'mobileClientTabSelectionsByDeviceId'
]

/** Pruning missing worktrees drops their metadata, lineage and scheduled messages. */
export const WORKTREE_METADATA_PRUNE_DOMAINS: readonly string[] = [
  ...WORKTREE_METADATA_DOMAINS,
  ...WORKSPACE_LINEAGE_DOMAINS,
  'scheduledMessages'
]

/** Removing worktree metadata also drops its lineage and saved session tabs. */
export const WORKTREE_METADATA_REMOVAL_DOMAINS: readonly string[] = [
  ...WORKTREE_METADATA_PRUNE_DOMAINS,
  ...WORKSPACE_SESSION_DOMAINS
]

/** A worktree locator move rewrites its metadata, lineage, sessions, phone selections and UI keys. */
export const WORKTREE_IDENTITY_MIGRATION_DOMAINS: readonly string[] = [
  ...WORKTREE_METADATA_REMOVAL_DOMAINS,
  'mobileClientTabSelectionsByDeviceId',
  'ui'
]
