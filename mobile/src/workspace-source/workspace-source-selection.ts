import {
  isBranchCheckedOutInWorktrees,
  resolveComposerBranchReuse,
  resolveComposerBranchSelection,
  resolveComposerReuseOverride
} from '../../../src/shared/composer-branch-selection'
import { getForkPushWarning } from '../../../src/shared/fork-push-warning'
import { getLinearOrganizationUrlKeyFromIssueUrl } from '../../../src/shared/linear-links'
import {
  getLinearIssueWorkspaceName,
  getLinkedWorkItemWorkspaceName
} from '../../../src/shared/workspace-name'
import type { GitHubPrStartPoint, GitHubWorkItem, LinearIssue } from '../../../src/shared/types'
import type { ResolvedNewWorkspaceSource } from './new-workspace-source-types'
import type { WorkspaceNameState } from './workspace-source-name-state'

function githubWorkspaceIdentity(item: GitHubWorkItem): {
  seedName: string
  displayName: string
} {
  const identity = getLinkedWorkItemWorkspaceName({
    type: item.type,
    number: item.number,
    title: item.title,
    provider: 'github'
  })
  return (
    identity ?? {
      seedName: `${item.type}-${item.number}`,
      displayName: item.type === 'pr' ? `PR ${item.number}` : `Issue ${item.number}`
    }
  )
}

export function resolveGitHubWorkspaceSource(
  item: GitHubWorkItem,
  prStartPoint?: GitHubPrStartPoint
): ResolvedNewWorkspaceSource {
  const identity = githubWorkspaceIdentity(item)
  return {
    kind: 'github',
    item,
    suggestedName: identity.seedName,
    displayName: identity.displayName,
    ...(prStartPoint ? { prStartPoint } : {}),
    forkWarning: prStartPoint ? getForkPushWarning(prStartPoint) : null
  }
}

export function resolveLinearWorkspaceSource(issue: LinearIssue): ResolvedNewWorkspaceSource {
  const identity = getLinkedWorkItemWorkspaceName({
    type: 'issue',
    number: 0,
    title: issue.title,
    provider: 'linear',
    linearIdentifier: issue.identifier
  })
  return {
    kind: 'linear',
    issue,
    suggestedName: getLinearIssueWorkspaceName(issue) || issue.identifier.toLowerCase(),
    displayName: identity?.displayName ?? issue.identifier,
    organizationUrlKey: getLinearOrganizationUrlKeyFromIssueUrl(issue.url)
  }
}

export function resolveBranchWorkspaceSource(args: {
  refName: string
  localBranchName: string
  verified: boolean
  name: WorkspaceNameState
  worktreeBranches: readonly string[]
}): ResolvedNewWorkspaceSource {
  const selection = resolveComposerBranchSelection({
    refName: args.refName,
    localBranchName: args.localBranchName,
    currentName: args.name.value,
    lastAutoName: args.name.owner === 'source' ? args.name.value : ''
  })
  const branchCheckedOutElsewhere = isBranchCheckedOutInWorktrees(
    args.localBranchName,
    args.worktreeBranches
  )
  const selectionProducedOverride =
    args.verified && args.name.owner !== 'user' && selection.branchNameOverride !== undefined
  const reuse = args.verified
    ? resolveComposerBranchReuse({
        refName: args.refName,
        localBranchName: args.localBranchName,
        selectionProducedOverride,
        branchCheckedOutElsewhere
      })
    : { reuseEligibleBranch: null, defaultReuse: false }
  const branchNameOverride = args.verified
    ? resolveComposerReuseOverride({
        refName: args.refName,
        localBranchName: args.localBranchName,
        branchNameOverride: selection.branchNameOverride,
        branchCheckedOutElsewhere
      })
    : undefined
  return {
    kind: 'branch',
    refName: args.refName,
    localBranchName: args.localBranchName,
    verified: args.verified,
    branchAutoName: selection.branchAutoName,
    branchNameOverride,
    reuseEligibleBranch: reuse.reuseEligibleBranch,
    reuseEnabled: reuse.defaultReuse
  }
}
