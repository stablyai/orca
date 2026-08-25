import type { SmartWorkspaceSourceRow } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import type { MobileComposerSource } from './use-mobile-composer-source'

export function applySmartWorkspaceSourceSelection(
  row: SmartWorkspaceSourceRow,
  composer: MobileComposerSource
): void {
  switch (row.kind) {
    case 'use-name':
      composer.setName(row.name)
      return
    case 'create-branch':
      composer.handleSmartCreateBranch(row.name)
      return
    case 'github':
      composer.handleSmartGitHubItemSelect(row.item)
      return
    case 'gitlab':
      composer.handleSmartGitLabItemSelect(row.item)
      return
    case 'branch':
      composer.handleSmartBranchSelect(row.refName, row.localBranchName)
      return
    case 'linear':
      composer.handleSmartLinearIssueSelect(row.issue)
      return
    case 'clickup':
      composer.handleSmartClickUpTaskSelect(row.task)
  }
}
