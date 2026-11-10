import { WORKTREE_METADATA_DOMAINS } from '../profile-save-domains'

/** An imported catalog adds repos, workspaces and their dormant state, and records its receipts. */
export const ORCAD_CATALOG_COMMIT_DOMAINS = [
  'projectGroups',
  'repos',
  'folderWorkspaces',
  'projects',
  'projectHostSetups',
  ...WORKTREE_METADATA_DOMAINS,
  'worktreeLineageById',
  'workspaceLineageByChildKey',
  'sparsePresetsByRepo',
  'retiredWorktreeNamesByRepo',
  'retiredWorktreeNamesByNamespace',
  'workspaceSession',
  'automations',
  'automationRuns',
  'mobileClientTabSelectionsByDeviceId',
  'ui',
  'orcadMigrationStagedCatalogs',
  'orcadMigrationImportReceipts',
  'orcadMigrationEvictedReceipts'
]
