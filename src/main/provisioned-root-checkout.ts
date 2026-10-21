/** The host-independent half of adopting a recipe's provisioned root: checkout proof and metadata. */
import { randomUUID } from 'node:crypto'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type { CreateWorktreeArgs } from '../shared/worktree/create-types'
import type { ExecutionHostId } from '../shared/execution-host'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { AutomationWorkspaceProvenance, GitWorktreeInfo } from '../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import { getProjectHostSetupWorktreeMeta } from '../shared/project-host-setup-lookup'
import { isTuiAgent } from '../shared/tui-agent-config'
import { getWorktreeCreationLayout } from './ipc/worktree-logic'
import {
  resolveWorktreeCreateDisplayNameMeta,
  resolveWorktreeCreateDisplayNameRequest
} from './ipc/worktree-display-name'

export type ProvisionedRootRequest = Pick<
  CreateWorktreeArgs,
  | 'name'
  | 'nameWasGenerated'
  | 'displayName'
  | 'displayNameKind'
  | 'baseBranch'
  | 'compareBaseRef'
  | 'branchNameOverride'
  | 'sparseCheckout'
  | 'linkedIssue'
  | 'linkedPR'
  | 'linkedLinearIssue'
  | 'linkedLinearIssueWorkspaceId'
  | 'linkedLinearIssueOrganizationUrlKey'
  | 'linkedGitLabIssue'
  | 'linkedGitLabMR'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'
  | 'linkedWorkItem'
  | 'linkedItems'
  | 'linkedTaskSourceContext'
  | 'pushTarget'
  | 'workspaceStatus'
  | 'manualOrder'
  | 'createdWithAgent'
  | 'pendingFirstAgentMessageRename'
> & {
  expectedRefHead?: string
  automationProvenance?: AutomationWorkspaceProvenance
}

export function provisionedRootPathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

/** The project root must be the repo's only, primary, non-sparse checkout on the requested branch and ref. */
export function verifyProvisionedRootCheckout(args: {
  worktrees: readonly GitWorktreeInfo[]
  sparseCheckoutEnabled: boolean
  projectRoot: string
  request: Pick<ProvisionedRootRequest, 'name' | 'branchNameOverride' | 'baseBranch'> & {
    expectedRefHead?: string
  }
}): GitWorktreeInfo {
  const { request } = args
  const matches = args.worktrees.filter((worktree) =>
    provisionedRootPathsEqual(worktree.path, args.projectRoot)
  )
  if (matches.length !== 1) {
    throw new Error('The recipe projectRoot is not a unique Git checkout root.')
  }
  const gitWorktree = matches[0]
  if (!gitWorktree.isMainWorktree) {
    throw new Error('The recipe projectRoot must be the repository primary checkout.')
  }
  if (gitWorktree.isBare) {
    throw new Error('Provisioned-root recipes cannot adopt a bare repository.')
  }
  if (gitWorktree.isSparse || args.sparseCheckoutEnabled) {
    throw new Error('Provisioned-root recipes cannot adopt a sparse checkout.')
  }
  const requestedBranch = request.branchNameOverride ?? request.name
  if (gitWorktree.branch !== `refs/heads/${requestedBranch}`) {
    throw new Error("The recipe projectRoot is not checked out on Orca's requested branch.")
  }
  if (request.baseBranch && !request.expectedRefHead) {
    throw new Error('The requested provisioned-root ref identity is missing.')
  }
  if (request.expectedRefHead && gitWorktree.head !== request.expectedRefHead) {
    throw new Error("The recipe projectRoot was not created from Orca's requested ref.")
  }
  return gitWorktree
}

export type ProvisionedRootMetaStore = {
  getProjectHostSetups?: Store['getProjectHostSetups']
  getSettings(): Parameters<typeof getWorktreeCreationLayout>[1]
}

export function buildProvisionedRootMeta(
  store: ProvisionedRootMetaStore,
  repo: Repo,
  args: ProvisionedRootRequest,
  options: {
    branchName: string
    now: number
    /** Omitted on the host that runs the checkout, whose own rows carry no host id. */
    hostId?: ExecutionHostId
    source: NonNullable<WorktreeMeta['orcaCreationSource']>
  }
): Partial<WorktreeMeta> {
  const { branchName, now } = options
  const displayNameRequest = resolveWorktreeCreateDisplayNameRequest(
    args.displayName,
    args.displayNameKind,
    args.name,
    false,
    args.nameWasGenerated === true
  )
  const displayNameMeta = resolveWorktreeCreateDisplayNameMeta(
    displayNameRequest.value,
    branchName,
    displayNameRequest.kind,
    { requestedName: args.name, sanitizedName: args.name }
  )
  return {
    instanceId: randomUUID(),
    ...(store.getProjectHostSetups
      ? getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
      : {}),
    ...(options.hostId ? { hostId: options.hostId } : {}),
    ephemeralVmCheckoutMode: 'provisioned-root',
    displayName: displayNameMeta.displayName ?? args.name,
    ...displayNameMeta,
    lastActivityAt: now,
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: options.source,
    creatorProvenance: { kind: 'host' },
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, store.getSettings()),
    ...(args.automationProvenance ? { automationProvenance: args.automationProvenance } : {}),
    ...(args.compareBaseRef || args.baseBranch
      ? { baseRef: args.compareBaseRef ?? args.baseBranch }
      : {}),
    ...(args.pushTarget ? { pushTarget: args.pushTarget } : {}),
    ...(isTuiAgent(args.createdWithAgent) ? { createdWithAgent: args.createdWithAgent } : {}),
    ...(args.pendingFirstAgentMessageRename === true && isTuiAgent(args.createdWithAgent)
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(args.linkedIssue !== undefined ? { linkedIssue: args.linkedIssue } : {}),
    ...(args.linkedPR !== undefined ? { linkedPR: args.linkedPR } : {}),
    ...(args.linkedLinearIssue !== undefined ? { linkedLinearIssue: args.linkedLinearIssue } : {}),
    ...(args.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId }
      : {}),
    ...(args.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(args.manualOrder !== undefined ? { manualOrder: args.manualOrder } : {}),
    ...(args.workspaceStatus !== undefined ? { workspaceStatus: args.workspaceStatus } : {}),
    ...(args.linkedGitLabIssue !== undefined ? { linkedGitLabIssue: args.linkedGitLabIssue } : {}),
    ...(args.linkedGitLabMR !== undefined ? { linkedGitLabMR: args.linkedGitLabMR } : {}),
    ...(args.linkedBitbucketPR !== undefined ? { linkedBitbucketPR: args.linkedBitbucketPR } : {}),
    ...(args.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: args.linkedAzureDevOpsPR }
      : {}),
    ...(args.linkedGiteaPR !== undefined ? { linkedGiteaPR: args.linkedGiteaPR } : {}),
    ...(args.linkedWorkItem !== undefined ? { linkedWorkItem: args.linkedWorkItem } : {}),
    ...(args.linkedItems !== undefined ? { linkedItems: args.linkedItems } : {}),
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {})
  }
}
