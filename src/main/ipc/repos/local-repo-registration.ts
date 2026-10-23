import { randomUUID } from 'node:crypto'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/constants'
import { getRepoName } from '../../git/repo'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { placeProject, type ProjectPlacement } from '../../wsl/project-placement'
import { requireSavedProject } from '../../repository-checkout-admission'
import { registerOnWslOwner } from '../../wsl/wsl-project-registration'

export async function addLocalRepoFromPath(
  store: Store,
  path: string,
  kind: 'git' | 'folder' = 'git',
  displayName?: string
): Promise<{ repo: Repo; alreadyExisted: boolean } | { error: string }> {
  const repoKind = kind === 'folder' ? 'folder' : 'git'
  let placement: ProjectPlacement
  try {
    // Desktop selections are placed on this computer's own domain.
    placement = await placeProject(store, {
      operation: 'add',
      selectedPath: path,
      kind: repoKind,
      domain: LOCAL_EXECUTION_HOST_ID,
      fromPairedClient: false,
      claimsOutsideWsl: { scope: 'desktop' }
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  return registerPlacedDesktopProject(store, placement, repoKind, displayName)
}

/** The ordinary writer: it reuses the placement's admission and never admits again. */
export async function registerPlacedDesktopProject(
  store: Store,
  placement: ProjectPlacement,
  repoKind: 'git' | 'folder',
  displayName?: string
): Promise<{ repo: Repo; alreadyExisted: boolean }> {
  if (placement.kind === 'saved') {
    // The exact claimed row, still saved right before it is linked or returned.
    const repo = requireSavedProject(store, placement.repo)
    return { repo, alreadyExisted: true }
  }
  if (placement.kind === 'wsl') {
    const result = await registerOnWslOwner(placement.authority, {
      kind: 'add',
      path: placement.linuxPath,
      repoKind,
      displayName
    })
    return { repo: result.repo, alreadyExisted: result.kind === 'saved' }
  }
  const { admission } = placement
  const resolvedPath = admission.registrationPath
  const detected = await detectRepoIconAndUpstream({
    repoPath: resolvedPath,
    kind: repoKind,
    executionHostId: LOCAL_EXECUTION_HOST_ID
  })
  // Another registration can finish while icon discovery is pending.
  const raceWinner = admission.findSaved()
  if (raceWinner) {
    return { repo: raceWinner, alreadyExisted: true }
  }
  const repo: Repo = {
    id: randomUUID(),
    path: resolvedPath,
    displayName: displayName?.trim() || getRepoName(resolvedPath),
    badgeColor: DEFAULT_REPO_BADGE_COLOR,
    ...detected,
    addedAt: Date.now(),
    kind: repoKind,
    ...(repoKind === 'git'
      ? {
          externalWorktreeVisibilityLegacy: false,
          // Why: new Add Project imports are explicit ready host setups; 'legacy-repo' is reserved for older records/projection.
          projectHostSetupMethod: 'imported-existing-folder' as const
        }
      : {})
  }

  store.addRepo(repo)
  await prepareLocalWorktreeRootForRepo(store, repo)
  return { repo, alreadyExisted: false }
}
