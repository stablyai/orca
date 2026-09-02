import type { Repo } from '../../shared/repo-types'
import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type { getPRForBranch } from '../github/client'
import {
  computeWorktreePath,
  ensurePathWithinWorkspace,
  resolveWorktreeCreateDisplayNameRequest,
  sanitizeWorktreeName,
  type getWorktreePathSettings
} from '../ipc/worktree-logic'
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
  }
  worktreePathSettings: ReturnType<typeof getWorktreePathSettings>
  workspaceRoot: string
  username: string
  store?: RuntimeStore
  baseBranch: string
  localWorktreeGitOptions: { wslDistro?: string }
  localWorktreeGitOptionArgs: [] | [{ wslDistro?: string }]
  hostedReviewExecutionContext?: HostedReviewExecutionOptions
}): Promise<RuntimeLocalWorktreeCreateCandidate> {
  const sanitizedName = sanitizeWorktreeName(args.request.name)
  let effectiveRequestedName = args.request.name
  let effectiveSanitizedName = sanitizedName
  let branchName = ''
  let checkoutExistingBranch = false
  let selectedExistingLocalBranchName: string | null = null
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
    branchName = await resolveCreateBranchName(
      args.repo.path,
      selectedExistingLocalBranchName ??
        getBranchNameOverrideCandidate(args.request.branchNameOverride, suffix),
      effectiveSanitizedName,
      args.settings,
      args.username,
      args.localWorktreeGitOptions
    )
    checkoutExistingBranch = await canCheckoutExistingLocalBranch(
      args.repo.path,
      branchName,
      args.baseBranch,
      ...args.localWorktreeGitOptionArgs
    )
    if (checkoutExistingBranch && !selectedExistingLocalBranchName) {
      selectedExistingLocalBranchName = branchName
    }
    branchConflictKind = checkoutExistingBranch
      ? null
      : await getBranchConflictKind(
          args.repo.path,
          branchName,
          args.baseBranch,
          ...args.localWorktreeGitOptionArgs
        )
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
    worktreePath = ensurePathWithinWorkspace(
      computeWorktreePath(effectiveSanitizedName, args.repo.path, args.worktreePathSettings),
      args.workspaceRoot
    )
    if (!(await runtimePathExists(worktreePath))) {
      worktreePathResolved = true
      break
    }
  }
  if (!worktreePathResolved) {
    if (branchConflictKind) {
      throw new Error(
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
