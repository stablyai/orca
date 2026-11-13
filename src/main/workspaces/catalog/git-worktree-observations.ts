import type { Repo } from '../../../shared/repo-types'
import { getRepoKind } from '../../../shared/repo-kind'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import {
  equalGitWorktreeObservations,
  readGitWorktreeObservation
} from '../../../shared/worktree/git-worktree-observation'
import { getRepoExecutionHostId, getRepoRoutingConnectionId } from '../../../shared/execution-host'
import { composeWorktreeId, getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  getProjectHostSetupForRepo,
  getProjectHostSetupWorktreeMeta
} from '../../../shared/project-host-setup-lookup'
import {
  buildKnownOrcaWorkspaceLayouts,
  toDetectedWorktree
} from '../../../shared/worktree/ownership'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources
} from '../../../shared/worktree/visibility-sources'
import { resolveConfiguredWorktreeBasePaths } from '../../../shared/worktree/configured-worktree-base-path'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import {
  hostWorktreeTargetForRepo,
  readAllWorktreeMetaForRepo
} from '../../persistence/host-qualified-worktree-meta'
import { mergeWorktree } from '../../ipc/worktree-metadata-merge'
import { resolveWorktreeScanRuntime } from '../../runtime/workspaces/catalog/runtime-worktree-scan-cache'
import { getLocalWorktreeScanGeneration } from './local-worktree-scan-generation'
import { withoutInFlightWorktreeCreates } from '../creation/worktree-create-in-flight'
import { snapshotPendingWorktreeRemovals } from '../removal/worktree-removal-listing'

type ObservationStore = Pick<
  RuntimeStore,
  | 'getRepos'
  | 'getProjects'
  | 'getSettings'
  | 'getProjectHostSetups'
  | 'getAllWorktreeMeta'
  | 'getAllWorktreeMetaForHost'
  | 'getWorktreeMetaForHost'
  | 'setWorktreeMeta'
>

export function gitWorktreeObservationReader(
  store: Pick<ObservationStore, 'getProjectHostSetups'>,
  repo: Repo
) {
  const hostId = getRepoExecutionHostId(repo)
  const ownership = getProjectHostSetupWorktreeMeta(store.getProjectHostSetups?.() ?? [], repo)
  return (meta: WorktreeMeta | undefined) => {
    if (
      !meta ||
      (meta.hostId && meta.hostId !== hostId) ||
      (meta.projectHostSetupId && meta.projectHostSetupId !== ownership.projectHostSetupId)
    ) {
      return undefined
    }
    return readGitWorktreeObservation(meta.gitWorktree)
  }
}

export function isAdoptableGitWorktree(git: GitWorktreeInfo): boolean {
  return !git.isBare && !git.prunable && !!git.branch
}

// Capture before Git yields; a locator reused during the scan must not inherit its predecessor's facts.
export function captureGitWorktreeObservationCommit(store: ObservationStore, capturedRepo: Repo) {
  const repo = { ...capturedRepo }
  const hostId = getRepoExecutionHostId(repo)
  const generation = getLocalWorktreeScanGeneration(repo.id)
  const pendingAtStart = snapshotPendingWorktreeRemovals()
  const ownership = getProjectHostSetupWorktreeMeta(store.getProjectHostSetups?.() ?? [], repo)
  const runtimeKey = resolveWorktreeScanRuntime(store, repo).runtimeKey
  const setupKey = (current: Repo) => {
    const setup = getProjectHostSetupForRepo(store.getProjectHostSetups?.() ?? [], current)
    return JSON.stringify([
      setup.id,
      setup.projectId,
      setup.hostId,
      setup.repoId,
      setup.path,
      getRepoKind(setup)
    ])
  }
  const capturedSetupKey = setupKey(repo)
  const atStart = new Map<string, Pick<WorktreeMeta, 'instanceId' | 'projectHostSetupId'>>()
  const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
  for (const [id, meta] of Object.entries(readAllWorktreeMetaForRepo(store, repo))) {
    if (
      getRepoIdFromWorktreeId(id) === repo.id &&
      (meta.hostId ? meta.hostId === hostId : repoOwnerCount === 1)
    ) {
      atStart.set(id, { instanceId: meta.instanceId, projectHostSetupId: meta.projectHostSetupId })
    }
  }
  const isCurrent = (): boolean => {
    const owners = store
      .getRepos()
      .filter(
        (candidate) => candidate.id === repo.id && getRepoExecutionHostId(candidate) === hostId
      )
    const current = owners.length === 1 ? owners[0] : undefined
    return (
      getLocalWorktreeScanGeneration(repo.id) === generation &&
      !!current &&
      current.path === repo.path &&
      getRepoKind(current) === getRepoKind(repo) &&
      getRepoRoutingConnectionId(current) === getRepoRoutingConnectionId(repo) &&
      (current.executionHostId ?? null) === (repo.executionHostId ?? null) &&
      setupKey(current) === capturedSetupKey &&
      resolveWorktreeScanRuntime(store, current).runtimeKey === runtimeKey
    )
  }
  return {
    isCurrent,
    commit(gitWorktrees: readonly GitWorktreeInfo[]): void {
      if (!isCurrent()) {
        return
      }
      const prepareAdoption = () => {
        const settings = store.getSettings()
        return {
          settings,
          knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
          worktreeVisibilitySourceMatcher: createWorktreeVisibilitySourceMatcher(
            [repo.path, ...gitWorktrees.map((git) => git.path)],
            resolveCustomWorktreeVisibilitySources(repo, settings.worktreeVisibilityDefaults),
            resolveConfiguredWorktreeBasePaths(repo)
          )
        }
      }
      let adoption: ReturnType<typeof prepareAdoption> | undefined
      const currentMeta = readAllWorktreeMetaForRepo(store, repo)
      const pendingNow = snapshotPendingWorktreeRemovals()
      for (const git of withoutInFlightWorktreeCreates(repo.id, [...gitWorktrees])) {
        const id = composeWorktreeId(repo.id, git.path)
        if (pendingAtStart.has(id) || pendingNow.has(id)) {
          continue
        }
        const captured = atStart.get(id)
        const existing = currentMeta[id]
        if (
          captured
            ? !existing ||
              existing.instanceId !== captured.instanceId ||
              existing.projectHostSetupId !== captured.projectHostSetupId
            : !!existing
        ) {
          continue
        }
        if (
          existing?.projectHostSetupId &&
          existing.projectHostSetupId !== ownership.projectHostSetupId
        ) {
          continue
        }
        if (!existing) {
          if (!isAdoptableGitWorktree(git)) {
            continue
          }
          if (
            !toDetectedWorktree({
              repo,
              worktree: mergeWorktree(repo.id, git, undefined, repo.displayName),
              meta: undefined,
              ...(adoption ??= prepareAdoption())
            }).visible
          ) {
            continue
          }
        }
        const observation = {
          isBare: git.isBare,
          isMainWorktree: git.isMainWorktree,
          branch: git.branch,
          prunable: git.prunable === true
        }
        if (!equalGitWorktreeObservations(existing?.gitWorktree, observation)) {
          store.setWorktreeMeta(hostWorktreeTargetForRepo(id, repo), {
            ...(!existing ? { ...ownership, lastActivityAt: Date.now() } : {}),
            gitWorktree: observation
          })
        }
      }
    }
  }
}
