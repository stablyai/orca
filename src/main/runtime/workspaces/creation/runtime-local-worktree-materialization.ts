import type { LocalGitExecOptions } from '../../../git/refs/resolution/repo-default-base-ref'
import { randomUUID } from 'node:crypto'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { getProjectHostSetupWorktreeMeta } from '../../../../shared/project/host-setup/project-host-setup-lookup'
import type { GitWorktreeInfo, GitPushTarget, Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { CreateWorktreeArgs } from '../../../../shared/worktree/create-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { getWorktreeCreationLayout } from '../../../ipc/worktrees/paths/worktree-logic'
import { mergeWorktree } from '../../../ipc/worktrees/metadata/worktree-metadata-merge'
import { resolveWorktreeCreateDisplayNameMeta } from '../../../ipc/worktrees/creation/worktree-display-name'
import { materializeWorktreeContentPaths } from '../../../ipc/worktrees/linked-paths/materialize-worktree-content-paths'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RemoteTrackingBase } from '../../repositories/runtime-remote-fetch-controller'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { attributedSparsePresetId } from '../../../ipc/repos/sparse-preset-attribution'
import type { WorktreeCreateTimingRecorder } from '../../../workspaces/creation/worktree-create-timing'
import { hostWorktreeTargetForRepo } from '../../../persistence/host-qualified-worktree-meta'

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
  localWorktreeGitOptions: LocalGitExecOptions
  onMetadataPersisted: (worktree: Worktree) => T
  timing: WorktreeCreateTimingRecorder
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
    localWorktreeGitOptions,
    timing
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
  const meta = timing.timeSync('persist_metadata', () =>
    store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), {
      instanceId: randomUUID(),
      ...getProjectHostSetupWorktreeMeta(store.getProjectHostSetups?.() ?? [], repo),
      lastActivityAt: now,
      createdAt: now,
      orcaCreatedAt: now,
      orcaCreationSource: 'runtime',
      orcaCreationWorkspaceLayout: getWorktreeCreationLayout(repo, settings),
      ...displayNameMeta,
      baseRef: metadataBaseRef,
      ...(checkoutExistingBranch || request.branchIntent === 'open-existing-v2'
        ? { preserveBranchOnDelete: true }
        : {}),
      ...(configuredPushTarget ? { pushTarget: configuredPushTarget } : {}),
      ...(sparseDirectories.length > 0
        ? {
            sparseDirectories,
            sparseBaseRef: metadataBaseRef,
            sparsePresetId: attributedSparsePresetId(
              () => store.getSparsePresets?.(repo.id) ?? [],
              repo.id,
              request.sparseCheckout?.presetId,
              sparseDirectories
            )
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
      ...(request.linkedItems !== undefined ? { linkedItems: request.linkedItems } : {}),
      ...(request.linkedTaskSourceContext !== undefined
        ? { linkedTaskSourceContext: request.linkedTaskSourceContext }
        : {}),
      ...(effectiveCreatedWithAgent ? { createdWithAgent: effectiveCreatedWithAgent } : {}),
      ...(request.pendingFirstAgentMessageRename === true && effectiveCreatedWithAgent
        ? { pendingFirstAgentMessageRename: true }
        : {}),
      ...(request.automationProvenance
        ? { automationProvenance: request.automationProvenance }
        : {}),
      ...(request.cliProvenance ? { cliProvenance: request.cliProvenance } : {}),
      creatorProvenance: request.creatorProvenance ?? { kind: 'host' },
      ...(request.comment !== undefined ? { comment: request.comment } : {}),
      ...(request.manualOrder !== undefined ? { manualOrder: request.manualOrder } : {}),
      ...(request.workspaceStatus !== undefined ? { workspaceStatus: request.workspaceStatus } : {})
    })
  )
  const worktree = {
    ...mergeWorktree(repo.id, created, meta),
    hostId: meta.hostId ?? getRepoExecutionHostId(repo)
  }
  const metadataResult = args.onMetadataPersisted(worktree)
  const { includeCopyWarning } = await materializeWorktreeContentPaths(
    repo,
    created.path,
    localWorktreeGitOptions,
    timing
  )
  return { worktree, metadataResult, ...(includeCopyWarning ? { includeCopyWarning } : {}) }
}
