import { randomUUID } from 'node:crypto'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getProjectHostSetupWorktreeMeta } from '../../shared/project-host-setup-lookup'
import type { GitWorktreeInfo, GitPushTarget, Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveWorktreeIncludePaths } from '../git/worktree-include-file'
import { formatWorktreeIncludeCopyWarning } from '../ipc/worktree-include-copy-budget'
import {
  getWorktreeCreationLayout,
  mergeWorktree,
  resolveWorktreeCreateDisplayNameMeta
} from '../ipc/worktree-logic'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from '../ipc/worktree-symlinks'
import { resolveWorktreeSharedDirectories } from '../git/worktree-shared-directories'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RemoteTrackingBase } from './runtime-remote-fetch-controller'
import type { RuntimeStore } from './runtime-store-contract'

export async function materializeRuntimeLocalWorktree<T>(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  store: RuntimeStore
  settings: Parameters<typeof getWorktreeCreationLayout>[1]
  created: GitWorktreeInfo
  remoteTrackingBase: RemoteTrackingBase | null
  sparseDirectories: string[]
  configuredPushTarget?: GitPushTarget
  checkoutExistingBranch: boolean
  baseBranch: string
  branchName: string
  effectiveRequestedName: string
  requestedDisplayName?: string
  displayNameKind: CreateWorktreeArgs['displayNameKind']
  effectiveSanitizedName: string
  effectiveCreatedWithAgent?: TuiAgent
  localWorktreeGitOptions: { wslDistro?: string }
  onMetadataPersisted: (worktree: Worktree) => T
}): Promise<{ worktree: Worktree; metadataResult: T; includeCopyWarning?: string }> {
  const {
    request,
    repo,
    store,
    settings,
    created,
    remoteTrackingBase,
    sparseDirectories,
    configuredPushTarget,
    checkoutExistingBranch,
    baseBranch,
    branchName,
    effectiveRequestedName,
    requestedDisplayName,
    displayNameKind,
    effectiveSanitizedName,
    effectiveCreatedWithAgent,
    localWorktreeGitOptions
  } = args
  const worktreeId = `${repo.id}::${created.path}`
  const now = Date.now()
  const metadataBaseRef = request.compareBaseRef ?? remoteTrackingBase?.ref ?? baseBranch
  const displayNameMeta = resolveWorktreeCreateDisplayNameMeta(
    requestedDisplayName,
    branchName,
    displayNameKind,
    { requestedName: effectiveRequestedName, sanitizedName: effectiveSanitizedName }
  )
  const meta = store.setWorktreeMeta(worktreeId, {
    instanceId: randomUUID(),
    ...getProjectHostSetupWorktreeMeta(store.getProjectHostSetups?.() ?? [], repo),
    lastActivityAt: now,
    createdAt: now,
    orcaCreatedAt: now,
    orcaCreationSource: 'runtime',
    orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
    ...displayNameMeta,
    baseRef: metadataBaseRef,
    ...(checkoutExistingBranch ? { preserveBranchOnDelete: true } : {}),
    ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
    ...(sparseDirectories.length > 0
      ? {
          sparseDirectories,
          sparseBaseRef: metadataBaseRef,
          sparsePresetId: request.sparseCheckout?.presetId
        }
      : {}),
    ...(request.linkedIssue !== undefined ? { linkedIssue: request.linkedIssue } : {}),
    ...(request.linkedPR !== undefined ? { linkedPR: request.linkedPR } : {}),
    ...(request.linkedLinearIssue !== undefined
      ? { linkedLinearIssue: request.linkedLinearIssue }
      : {}),
    ...(request.linkedLinearIssueWorkspaceId !== undefined
      ? { linkedLinearIssueWorkspaceId: request.linkedLinearIssueWorkspaceId }
      : {}),
    ...(request.linkedLinearIssueOrganizationUrlKey !== undefined
      ? { linkedLinearIssueOrganizationUrlKey: request.linkedLinearIssueOrganizationUrlKey }
      : {}),
    ...(request.linkedGitLabIssue !== undefined
      ? { linkedGitLabIssue: request.linkedGitLabIssue }
      : {}),
    ...(request.linkedGitLabMR !== undefined ? { linkedGitLabMR: request.linkedGitLabMR } : {}),
    ...(request.linkedBitbucketPR !== undefined
      ? { linkedBitbucketPR: request.linkedBitbucketPR }
      : {}),
    ...(request.linkedAzureDevOpsPR !== undefined
      ? { linkedAzureDevOpsPR: request.linkedAzureDevOpsPR }
      : {}),
    ...(request.linkedGiteaPR !== undefined ? { linkedGiteaPR: request.linkedGiteaPR } : {}),
    ...(request.linkedWorkItem !== undefined ? { linkedWorkItem: request.linkedWorkItem } : {}),
    ...(request.linkedTaskSourceContext !== undefined
      ? { linkedTaskSourceContext: request.linkedTaskSourceContext }
      : {}),
    ...(effectiveCreatedWithAgent ? { createdWithAgent: effectiveCreatedWithAgent } : {}),
    ...(request.pendingFirstAgentMessageRename === true && effectiveCreatedWithAgent
      ? { pendingFirstAgentMessageRename: true }
      : {}),
    ...(request.automationProvenance ? { automationProvenance: request.automationProvenance } : {}),
    ...(request.cliProvenance ? { cliProvenance: request.cliProvenance } : {}),
    creatorProvenance: request.creatorProvenance ?? { kind: 'host' },
    ...(request.comment !== undefined ? { comment: request.comment } : {}),
    ...(request.manualOrder !== undefined ? { manualOrder: request.manualOrder } : {}),
    ...(request.workspaceStatus !== undefined ? { workspaceStatus: request.workspaceStatus } : {})
  })
  const worktree = {
    ...mergeWorktree(repo.id, created, meta),
    hostId: meta.hostId ?? getRepoExecutionHostId(repo)
  }
  const metadataResult = args.onMetadataPersisted(worktree)

  if ((repo.symlinkPaths ?? []).length > 0) {
    await createWorktreeLinkedPaths(repo.path, created.path, repo.symlinkPaths ?? [])
  }
  // These discoveries are read-only; overlap them, but keep the shared-path
  // mutation ahead of include copies below.
  const [sharedDirectories, worktreeIncludePaths] = await Promise.all([
    resolveWorktreeSharedDirectories(repo.path, localWorktreeGitOptions),
    resolveWorktreeIncludePaths(repo.path, localWorktreeGitOptions)
  ])
  if (sharedDirectories.length > 0) {
    await createWorktreeSharedPaths(repo.path, created.path, sharedDirectories)
  }
  if (worktreeIncludePaths.length === 0) {
    return { worktree, metadataResult }
  }
  const skippedIncludePaths = await createWorktreeCopiedPaths(
    repo.path,
    created.path,
    worktreeIncludePaths
  )
  const includeCopyWarning = formatWorktreeIncludeCopyWarning(skippedIncludePaths)
  if (includeCopyWarning) {
    console.warn(`[worktree-include] ${includeCopyWarning}`)
  }
  return { worktree, metadataResult, ...(includeCopyWarning ? { includeCopyWarning } : {}) }
}
