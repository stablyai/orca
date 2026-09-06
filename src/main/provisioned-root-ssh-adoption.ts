import { randomUUID } from 'node:crypto'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import type {
  AdoptProvisionedRootArgs,
  CreateWorktreeResult
} from '../shared/worktree/create-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { AutomationWorkspaceProvenance } from '../shared/worktree/types'
import { isRuntimeOwnedSshTargetId, toSshExecutionHostId } from '../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from '../shared/ephemeral-vm-recipes'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { getProjectHostSetupWorktreeMeta } from '../shared/project-host-setup-lookup'
import { isTuiAgent } from '../shared/tui-agent-config'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority
} from './ssh/ssh-provider-authority'
import { attachEphemeralVmRuntimeToWorkspace } from './ephemeral-vm-runtime-attachment'
import {
  getWorktreeCreationLayout,
  mergeWorktree,
  resolveWorktreeCreateDisplayNameMeta,
  resolveWorktreeCreateDisplayNameRequest
} from './ipc/worktree-logic'

type AdoptionArgs = AdoptProvisionedRootArgs & {
  automationProvenance?: AutomationWorkspaceProvenance
}

export async function adoptProvisionedRootSshCheckout(args: {
  userDataPath: string
  request: AdoptionArgs
  repo: Repo
  store: Store
  isRepoCurrent: () => boolean
}): Promise<CreateWorktreeResult> {
  const { request, repo, store } = args
  if (request.sparseCheckout) {
    throw new Error('Provisioned-root recipes do not support sparse checkout.')
  }
  const connectionId = repo.connectionId
  if (!connectionId || !isRuntimeOwnedSshTargetId(connectionId)) {
    throw new Error('Provisioned-root adoption requires a runtime-owned SSH target.')
  }
  if (request.executionHostId !== toSshExecutionHostId(connectionId)) {
    throw new Error('Provisioned-root workspace host does not match its SSH target.')
  }

  const runtime = requireOwnedProvisionedRootRuntime(
    args.userDataPath,
    request.runtimeId,
    connectionId
  )
  const projectRoot = getEphemeralVmRecipeResultProjectRoot(runtime.recipeResult)
  if (!pathsEqual(request.expectedPath, projectRoot) || !pathsEqual(repo.path, projectRoot)) {
    throw new Error('The recipe projectRoot does not match the imported Git checkout root.')
  }

  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    throw new Error('The recipe-created SSH connection is no longer available.')
  }
  const authority = { ...getSshProviderAuthority(connectionId) }
  const [worktrees, sparseCheckoutEnabled] = await Promise.all([
    provider.listWorktrees(repo.path),
    isSparseCheckoutEnabled(provider, projectRoot)
  ])
  if (
    getSshGitProvider(connectionId) !== provider ||
    !isCurrentSshProviderAuthority(authority) ||
    !args.isRepoCurrent()
  ) {
    throw new Error('The recipe-created SSH connection changed during checkout verification.')
  }
  requireOwnedProvisionedRootRuntime(args.userDataPath, request.runtimeId, connectionId)

  const matches = worktrees.filter((worktree) => pathsEqual(worktree.path, projectRoot))
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
  if (gitWorktree.isSparse || sparseCheckoutEnabled) {
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

  const worktreeId = `${repo.id}::${gitWorktree.path}`
  attachEphemeralVmRuntimeToWorkspace({
    userDataPath: args.userDataPath,
    runtimeId: request.runtimeId,
    workspaceId: worktreeId
  })
  const now = Date.now()
  const meta = store.setWorktreeMeta(
    worktreeId,
    buildProvisionedRootMeta(
      store,
      repo,
      request,
      gitWorktree.branch.replace(/^refs\/heads\//, ''),
      now
    )
  )
  return { worktree: mergeWorktree(repo.id, gitWorktree, meta) }
}

async function isSparseCheckoutEnabled(
  provider: NonNullable<ReturnType<typeof getSshGitProvider>>,
  projectRoot: string
): Promise<boolean> {
  const { stdout } = await provider.exec(
    ['config', '--bool', '--get', '--default=false', 'core.sparseCheckout'],
    projectRoot
  )
  return stdout.trim() === 'true'
}

function requireOwnedProvisionedRootRuntime(
  userDataPath: string,
  runtimeId: string,
  connectionId: string
): EphemeralVmRuntimeRecord {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
  }
  if (
    runtime.connectionMode !== 'ssh' ||
    runtime.sshTargetId !== connectionId ||
    runtime.recipe?.checkoutMode !== 'provisioned-root' ||
    getEphemeralVmRecipeResultCheckoutMode(runtime.recipeResult) !== 'provisioned-root' ||
    ['cleanup_pending', 'cleanup_failed', 'cleaned'].includes(runtime.status)
  ) {
    throw new Error('The ephemeral VM runtime does not own this provisioned SSH checkout.')
  }
  return runtime
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function buildProvisionedRootMeta(
  store: Store,
  repo: Repo,
  args: AdoptionArgs,
  branchName: string,
  now: number
): Partial<WorktreeMeta> {
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
    hostId: args.executionHostId,
    ephemeralVmCheckoutMode: 'provisioned-root',
    displayName: displayNameMeta.displayName ?? args.name,
    ...displayNameMeta,
    lastActivityAt: now,
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'ssh',
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
    ...(args.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: args.linkedTaskSourceContext }
      : {})
  }
}
