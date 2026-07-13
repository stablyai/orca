import { resolveComposerBranchNameOverrideForCreate } from '../../../src/shared/composer-branch-selection'
import type { ResolvedNewWorkspaceSource } from './new-workspace-source-types'
import type { WorkspaceNameState } from './workspace-source-name-state'

function suffixed(value: string, attempt: number): string {
  return attempt === 0 ? value : `${value}-${attempt + 1}`
}

export function buildWorkspaceSourceCreateCandidate(args: {
  baseParams: Record<string, unknown>
  baseName: string
  name: WorkspaceNameState
  source: ResolvedNewWorkspaceSource | null
  selectedRepoId: string
  attempt: number
}): Record<string, unknown> {
  const candidateName = suffixed(args.baseName, args.attempt)
  const source = args.source
  const params: Record<string, unknown> = {
    ...args.baseParams,
    repo: `id:${args.selectedRepoId}`,
    name: candidateName
  }
  if (!source) {
    return params
  }

  if (source.kind === 'github') {
    const startPoint = source.prStartPoint
    const branchNameOverride = startPoint?.branchNameOverride
      ? suffixed(startPoint.branchNameOverride, args.attempt)
      : undefined
    return {
      ...params,
      ...(args.name.owner === 'source' ? { displayName: source.displayName } : {}),
      ...(source.item.type === 'issue'
        ? { linkedIssue: source.item.number }
        : { linkedPR: source.item.number }),
      ...(startPoint
        ? {
            baseBranch: startPoint.baseBranch,
            ...(startPoint.compareBaseRef ? { compareBaseRef: startPoint.compareBaseRef } : {}),
            ...(branchNameOverride ? { branchNameOverride } : {}),
            ...(startPoint.pushTarget ? { pushTarget: startPoint.pushTarget } : {})
          }
        : {})
    }
  }

  if (source.kind === 'linear') {
    return {
      ...params,
      ...(args.name.owner === 'source' ? { displayName: source.displayName } : {}),
      linkedLinearIssue: source.issue.identifier,
      ...(source.issue.workspaceId
        ? { linkedLinearIssueWorkspaceId: source.issue.workspaceId }
        : {}),
      ...(source.organizationUrlKey
        ? { linkedLinearIssueOrganizationUrlKey: source.organizationUrlKey }
        : {})
    }
  }

  const exactReuse = source.reuseEligibleBranch !== null && source.reuseEnabled
  const resolvedOverride = exactReuse
    ? source.reuseEligibleBranch!
    : source.reuseEligibleBranch
      ? undefined
      : resolveComposerBranchNameOverrideForCreate({
          branchNameOverride: source.branchNameOverride,
          branchAutoName: source.branchAutoName,
          workspaceName: args.name.value.trim(),
          preserveWorkspaceNameEdits: false
        })
  const branchNameOverride =
    resolvedOverride && !exactReuse ? suffixed(resolvedOverride, args.attempt) : resolvedOverride
  return {
    ...params,
    baseBranch: source.refName,
    ...(branchNameOverride ? { branchNameOverride } : {})
  }
}
