import { selectWorktreeCreateBranchSeed } from '../worktree-create-branch-seed'
import type { Repo } from '../../shared/repo-types'
import { WorktreeCreateCollisionError } from '../../shared/new-workspace/worktree-create-collision'
import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type { getPRForBranch } from '../github/client'
import {
  computeWorktreePath,
  ensurePathWithinWorkspace,
  sanitizeWorktreeName,
  type getWorktreePathSettings
} from '../ipc/worktree-logic'
import { resolveWorktreeCreateDisplayNameRequest } from '../ipc/worktree-display-name'
import { getBranchConflictKind } from '../git/repo'
import {
  getBranchNameOverrideCandidate,
  getGeneratedWorktreeCreateCandidate,
  getWorktreeCreateCandidate,
  isGeneratedWorktreeCreateName,
  WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS
} from '../worktree-create-candidates'
import { createRetiredNameLookup } from '../../shared/worktree/retired-name-registry'
import { getRetiredNameRegistryForRepo } from '../worktree-name-retirement'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import {
  getSelectedReviewBranch,
  isAllowedPushTargetRemoteConflict,
  isMatchingSelectedGitHubPr
} from './selected-review-branch'
import {
  canCheckoutExistingLocalBranch,
  getLocalGitHubPrForBranch,
  getSelectedHostedReviewForBranch,
  resolveCreateBranchName
} from './runtime-worktree-create-git'
import { runtimePathExists } from './runtime-worktree-filesystem'
import { findPendingWorktreeRemovalConflict } from '../worktree-removal-table'
import type { WorktreeCreatePathClaim } from '../worktree-create-in-flight'
import type { RuntimeStore } from './runtime-store-contract'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'

export type RuntimeLocalWorktreeCreateCandidate = {
  effectiveRequestedName: string
  requestedDisplayName?: string
  displayNameKind: CreateWorktreeArgs['displayNameKind']
  effectiveSanitizedName: string
  branchName: string
  checkoutExistingBranch: boolean
  worktreePath: string
}

export async function resolveRuntimeLocalWorktreeCreateCandidate(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  settings: ReturnType<typeof getWorktreePathSettings> & {
    branchPrefix: string
    branchPrefixCustom?: string
    autoRenameBranchFromWork?: boolean
  }
  worktreePathSettings: ReturnType<typeof getWorktreePathSettings>
  workspaceRoot: string
  username: string
  store?: RuntimeStore
  baseBranch: string
  localWorktreeGitOptions: { wslDistro?: string }
  hostedReviewExecutionContext?: HostedReviewExecutionOptions
  pathClaim: WorktreeCreatePathClaim
}): Promise<RuntimeLocalWorktreeCreateCandidate> {
  const branchSeed = selectWorktreeCreateBranchSeed(
    args.request,
    args.settings.autoRenameBranchFromWork
  )
  const sanitizedName = sanitizeWorktreeName(args.request.name)
  let effectiveRequestedName = args.request.name
  let effectiveSanitizedName = sanitizedName
  let branchName = ''
  let checkoutExistingBranch = false
  let selectedExistingLocalBranchName: string | null = null
  let selectedRemoteBranchName: string | null = null
  let branchConflictKind: 'local' | 'remote' | null = null
  let worktreePath = ''
  let worktreePathResolved = false
  const shouldRetireGeneratedName =
    args.request.nameWasGenerated === true && isGeneratedWorktreeCreateName(sanitizedName)
  const retiredNameRegistry =
    shouldRetireGeneratedName &&
    args.store?.getRetiredWorktreeNameRegistry &&
    args.store.addRetiredWorktreeName &&
    args.store.mergeRetiredWorktreeNames
      ? await getRetiredNameRegistryForRepo(
          args.store as Parameters<typeof getRetiredNameRegistryForRepo>[0],
          args.repo,
          args.store.getRepos(),
          args.settings
        )
      : null
  const isRetiredName = retiredNameRegistry ? createRetiredNameLookup(retiredNameRegistry) : null
  if (
    args.request.branchIntent === 'open-existing' &&
    args.request.branchNameOverride &&
    !args.request.pushTarget &&
    getSelectedReviewBranch(args.request) === null
  ) {
    branchName = await resolveCreateBranchName(
      args.repo.path,
      args.request.branchNameOverride,
      sanitizedName,
      args.settings,
      args.username,
      args.localWorktreeGitOptions
    )
    const conflict = await getBranchConflictKind(
      args.repo.path,
      branchName,
      args.baseBranch,
      args.localWorktreeGitOptions
    )
    if (conflict === null) {
      selectedRemoteBranchName = branchName
    }
  }
  const pathIsAvailable = async (): Promise<boolean> => {
    worktreePath = ensurePathWithinWorkspace(
      computeWorktreePath(effectiveSanitizedName, args.repo.path, args.worktreePathSettings),
      args.workspaceRoot
    )
    // Orca owns the path until background removal settles.
    return (
      !findPendingWorktreeRemovalConflict(args.repo.path, { worktreePath }) &&
      !(await runtimePathExists(worktreePath)) &&
      args.pathClaim.claim(worktreePath)
    )
  }
  for (let suffix = 1, attempts = 0; attempts < WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS; suffix += 1) {
    effectiveSanitizedName = shouldRetireGeneratedName
      ? getGeneratedWorktreeCreateCandidate(
          sanitizedName,
          suffix,
          retiredNameRegistry?.exhaustedTiers
        )
      : getWorktreeCreateCandidate(sanitizedName, suffix)
    effectiveRequestedName = shouldRetireGeneratedName
      ? effectiveSanitizedName
      : args.request.name.trim()
        ? getWorktreeCreateCandidate(args.request.name, suffix)
        : effectiveSanitizedName
    if (isRetiredName?.(effectiveSanitizedName)) {
      continue
    }
    attempts += 1
    if (selectedRemoteBranchName) {
      if (await pathIsAvailable()) {
        worktreePathResolved = true
        break
      }
      continue
    }
    branchName = await resolveCreateBranchName(
      args.repo.path,
      selectedExistingLocalBranchName ??
        getBranchNameOverrideCandidate(args.request.branchNameOverride, suffix),
      branchSeed ? getWorktreeCreateCandidate(branchSeed, suffix) : effectiveSanitizedName,
      args.settings,
      args.username,
      args.localWorktreeGitOptions
    )
    const tryExistingBranch = async (): Promise<boolean> => {
      checkoutExistingBranch = await canCheckoutExistingLocalBranch(
        args.repo.path,
        branchName,
        args.baseBranch,
        args.localWorktreeGitOptions
      )
      return checkoutExistingBranch
    }
    const preferExistingBranch = Boolean(
      args.request.branchNameOverride || selectedExistingLocalBranchName
    )
    checkoutExistingBranch = preferExistingBranch && (await tryExistingBranch())
    branchConflictKind = checkoutExistingBranch
      ? null
      : await getBranchConflictKind(
          args.repo.path,
          branchName,
          args.baseBranch,
          args.localWorktreeGitOptions,
          preferExistingBranch ? undefined : tryExistingBranch
        )
    if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
      selectedExistingLocalBranchName = branchName
    }
    const allowedPushTargetRemoteConflict =
      branchConflictKind &&
      isAllowedPushTargetRemoteConflict(branchConflictKind, branchName, args.request)
    let selectedReviewConflictMatched = false
    if (branchConflictKind) {
      if (allowedPushTargetRemoteConflict) {
        let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
        const selectedReview = getSelectedReviewBranch(args.request)
        if (selectedReview?.provider === 'github') {
          try {
            existingPR = await getLocalGitHubPrForBranch(
              args.repo.path,
              branchName,
              args.localWorktreeGitOptions
            )
          } catch {}
          if (isMatchingSelectedGitHubPr(existingPR, args.request, branchName)) {
            branchConflictKind = null
            selectedReviewConflictMatched = true
          }
        } else if (selectedReview) {
          const review = await getSelectedHostedReviewForBranch(
            args.repo,
            branchName,
            args.request,
            args.hostedReviewExecutionContext
          ).catch(() => null)
          if (review?.matchesSelected) {
            branchConflictKind = null
            selectedReviewConflictMatched = true
          }
        }
      }
      if (branchConflictKind) {
        continue
      }
    }
    if (!checkoutExistingBranch && !selectedReviewConflictMatched) {
      let existingPR: Awaited<ReturnType<typeof getPRForBranch>> | null = null
      try {
        existingPR = await getLocalGitHubPrForBranch(
          args.repo.path,
          branchName,
          args.localWorktreeGitOptions
        )
      } catch {}
      if (existingPR && !isMatchingSelectedGitHubPr(existingPR, args.request, branchName)) {
        continue
      }
    }
    if (await pathIsAvailable()) {
      worktreePathResolved = true
      break
    }
  }
  if (!worktreePathResolved) {
    if (branchConflictKind) {
      throw new WorktreeCreateCollisionError(
        `Branch "${branchName}" already exists ${branchConflictKind === 'local' ? 'locally' : 'on a remote'}.`
      )
    }
    throw new Error(
      `Could not find an available worktree path for "${sanitizedName}". Pick a different worktree name.`
    )
  }
  const displayNameRequest = resolveWorktreeCreateDisplayNameRequest(
    args.request.displayName,
    args.request.displayNameKind,
    args.request.name,
    args.request.cliProvenance?.kind === 'created-by-cli',
    args.request.nameWasGenerated === true
  )
  return {
    effectiveRequestedName,
    requestedDisplayName: displayNameRequest.value,
    displayNameKind: displayNameRequest.kind,
    effectiveSanitizedName,
    branchName,
    checkoutExistingBranch,
    worktreePath
  }
}
