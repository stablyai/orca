import { realpath, stat } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { getErrorCode, type GitWorktreeExecOptions } from '../worktree-operation-options'
import { canonicalWorktreePath } from '../worktree-path-comparison'
import { annotateSparseCheckoutStatus } from '../worktree-sparse-annotation'
import { readRepoConfigFacts, resolveRepoCommonDirFromFiles } from './repo-admin-layout'
import { WorktreeRowsNeedGit } from './worktree-membership-file-rows'
import { stampUnplacedRepo, type UnplacedRepo } from './worktree-membership-not-repository'
import { validateMembershipFromFiles } from './worktree-membership-file-validation'
import {
  describeMembershipParityMismatch,
  readGitWorktreeRows,
  validateMembershipFromGit,
  type GitValidationResult
} from './worktree-membership-git-rows'
import {
  MEMBERSHIP_FULL_DERIVE_FLOOR_MS,
  type FileDerivationState,
  type MembershipDerivationStart,
  type WorktreeMembershipModel
} from './worktree-membership-model'

// How a membership model is built (one Git baseline plus the parity check) and re-derived. Native
// local repos only: WSL repos never get a model (a 9P stat can read an existing dir as absent).

/** The registered repo path no longer exists: the true empty answer, reached with one stat. */
export class MissingRepoPathError extends Error {
  readonly code = 'ENOENT'
  constructor(readonly repoPath: string) {
    super(`repo path missing: ${repoPath}`)
  }
}

async function assertRepoPathPresent(repoPath: string): Promise<void> {
  await stat(repoPath).catch((error: unknown) => {
    if (getErrorCode(error) === 'ENOENT') {
      throw new MissingRepoPathError(repoPath)
    }
  })
}

export function gitOptionsFor(options: GitWorktreeExecOptions): GitWorktreeExecOptions {
  // A shared derivation must not be cancelled by one caller's signal; callers race it instead.
  return {
    ...(options.timeout ? { timeout: options.timeout } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  }
}

function pinToGit(model: WorktreeMembershipModel, reason: string): void {
  model.source = { kind: 'git', reason }
  model.files = null
  console.warn(`[git/worktree-membership] using git worktree list for ${model.repoPath}: ${reason}`)
}

/** A model with nothing derived yet; the store registers it before its first build starts. */
export function createMembershipModelShell(
  key: string,
  repoPath: string,
  startedAt: number
): WorktreeMembershipModel {
  return {
    key,
    repoPath,
    commonDir: '',
    commonDirKey: '',
    main: { path: repoPath, isBare: false },
    source: { kind: 'files' },
    files: null,
    git: { entryNames: null, listingStamp: null, signature: undefined },
    rows: [],
    validated: { generation: 0, startedAt },
    fullDerivedAt: startedAt,
    lastReadAt: startedAt,
    generation: 0,
    listingOwed: false,
    building: null,
    inFlight: null,
    followUp: null,
    startedDerivations: 0,
    committedDerivation: 0
  }
}

/**
 * The model's first build, as generation 0's derivation. When files cannot even locate the repo's
 * common dir, it resolves with the folder's stamps instead and the caller leaves the repo to Git.
 */
export async function buildMembershipModel(
  model: WorktreeMembershipModel,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo[] | UnplacedRepo> {
  await assertRepoPathPresent(model.repoPath)
  const commonDir = await resolveRepoCommonDirFromFiles(model.repoPath).catch(() => null)
  if (!commonDir) {
    return stampUnplacedRepo(model.repoPath)
  }
  model.commonDir = commonDir
  model.commonDirKey = canonicalWorktreePath(await realpath(commonDir).catch(() => commonDir))
  const gitOptions = gitOptionsFor(options)
  const facts = await readRepoConfigFacts(commonDir).catch(() => null)
  const gitOnlyReason = facts === null ? 'unreadable config' : facts.gitOnlyReason
  if (!gitOnlyReason) {
    const { git, adoption } = await readGitGatedAdoption(model, gitOptions, null, true)
    applyGitGatedAdoption(model, git, adoption)
    model.rows = git.rows
    return model.rows
  }
  model.source = { kind: 'git', reason: gitOnlyReason }
  const git = await validateMembershipFromGit({
    repoPath: model.repoPath,
    commonDir,
    options: gitOptions,
    previous: model.git,
    previousRows: null,
    mustRun: true
  })
  model.git = git.state
  model.rows = git.rows
  model.main = { path: git.rows[0]?.path ?? model.repoPath, isBare: git.rows[0]?.isBare ?? false }
  return model.rows
}

type FileAdoption = {
  main: WorktreeMembershipModel['main']
  files: FileDerivationState
  rows: GitWorktreeInfo[]
}

/**
 * For a files model with no file state (or whose files just failed): Git's rows by the Git-derived
 * stat gate, so a file read that keeps failing costs no Git until a stat moves or the floor is due.
 * When Git does run, that listing is a new adoption attempt, and its baseline is the answer if the
 * files still fail.
 */
async function readGitGatedAdoption(
  model: WorktreeMembershipModel,
  gitOptions: GitWorktreeExecOptions,
  previousRows: GitWorktreeInfo[] | null,
  mustRun: boolean
): Promise<{ git: GitValidationResult; adoption: FileAdoption | null }> {
  let adoption: FileAdoption | null = null
  const git = await validateMembershipFromGit({
    repoPath: model.repoPath,
    commonDir: model.commonDir,
    options: gitOptions,
    previous: model.git,
    previousRows,
    mustRun,
    listRows: async () => {
      const attempt = await adoptFileRows(model, gitOptions)
      adoption = attempt.adoption
      return attempt.rows
    }
  })
  return { git, adoption }
}

function applyGitGatedAdoption(
  model: WorktreeMembershipModel,
  git: GitValidationResult,
  adoption: FileAdoption | null
): void {
  model.git = git.state
  if (adoption) {
    model.main = adoption.main
    model.files = adoption.files
  }
}

/**
 * The model's one `git worktree list`: it supplies the main row (path spelling, bareness), and the
 * file rows must reproduce it exactly or the repo stays on Git for this process. A mismatch is
 * re-checked against a second listing first, so a worktree changing between the two reads cannot
 * pin a healthy repo.
 */
async function adoptFileRows(
  model: WorktreeMembershipModel,
  gitOptions: GitWorktreeExecOptions
): Promise<{ adoption: FileAdoption | null; rows: GitWorktreeInfo[] }> {
  // Not adopted: Git's own baseline answers, with the sparse annotation files would have given.
  const answerFromGit = async (
    rows: GitWorktreeInfo[]
  ): Promise<{ adoption: null; rows: GitWorktreeInfo[] }> => ({
    adoption: null,
    rows: await annotateSparseCheckoutStatus(model.repoPath, rows, gitOptions)
  })
  let mismatch: string | null = null
  let baseline = await readGitWorktreeRows(model.repoPath, gitOptions, false)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      baseline = await readGitWorktreeRows(model.repoPath, gitOptions, false)
    }
    const gitMain = baseline.rows[0]
    if (!gitMain?.isMainWorktree) {
      pinToGit(model, 'git listed no main worktree')
      return answerFromGit(baseline.rows)
    }
    const main = { path: gitMain.path, isBare: gitMain.isBare }
    try {
      const derived = await validateMembershipFromFiles({
        commonDir: model.commonDir,
        main,
        previous: null,
        listingOwed: true,
        full: true
      })
      mismatch = describeMembershipParityMismatch(
        derived.rows,
        baseline.rows,
        baseline.nulDelimited
      )
      if (!mismatch) {
        return { adoption: { main, files: derived.state, rows: derived.rows }, rows: derived.rows }
      }
    } catch (error) {
      if (!(error instanceof WorktreeRowsNeedGit)) {
        throw error
      }
      if (!error.transient) {
        pinToGit(model, error.reason)
      }
      return answerFromGit(baseline.rows)
    }
  }
  pinToGit(model, `file rows differ from git: ${mismatch}`)
  return answerFromGit(baseline.rows)
}

export async function deriveMembershipModel(
  model: WorktreeMembershipModel,
  start: MembershipDerivationStart & { listingOwed: boolean },
  options: GitWorktreeExecOptions,
  derivation: number,
  dropModel: () => void
): Promise<GitWorktreeInfo[]> {
  const { startedAt, listingOwed } = start
  const full = startedAt - model.fullDerivedAt >= MEMBERSHIP_FULL_DERIVE_FLOOR_MS
  // Only the newest derivation commits; an older one still answers its own callers. What it
  // records is when and at which generation it started, which is all reuse ever looks at.
  const commit = (
    rows: GitWorktreeInfo[],
    apply: () => void,
    fullDerive = full
  ): GitWorktreeInfo[] => {
    if (derivation > model.committedDerivation) {
      model.committedDerivation = derivation
      apply()
      model.rows = rows
      model.validated = { generation: start.generation, startedAt }
      if (fullDerive) {
        model.fullDerivedAt = startedAt
      }
    }
    return rows
  }
  try {
    await assertRepoPathPresent(model.repoPath)
  } catch (error) {
    dropModel()
    throw error
  }
  if (
    !(await stat(model.commonDir).then(
      () => true,
      () => false
    ))
  ) {
    // The repo's Git dir is gone: drop the model so the next read re-resolves the layout, and let
    // Git give this read its answer (usually "not a git repository", a true empty).
    dropModel()
    return (await readGitWorktreeRows(model.repoPath, gitOptionsFor(options))).rows
  }
  if (model.source.kind === 'files' && model.files) {
    try {
      const result = await validateMembershipFromFiles({
        commonDir: model.commonDir,
        main: model.main,
        previous: model.files,
        listingOwed,
        full
      })
      return commit(result.rows, () => {
        model.files = result.state
      })
    } catch (error) {
      if (!(error instanceof WorktreeRowsNeedGit)) {
        throw error
      }
      if (!error.transient) {
        pinToGit(model, error.reason)
      }
    }
  }
  if (model.source.kind === 'files') {
    // No file state yet, or the files just failed to read: never adopt file rows unchecked.
    const { git, adoption } = await readGitGatedAdoption(
      model,
      gitOptionsFor(options),
      model.git.signature ? model.rows : null,
      full || listingOwed
    )
    return commit(git.rows, () => applyGitGatedAdoption(model, git, adoption), full || !!adoption)
  }
  const result = await validateMembershipFromGit({
    repoPath: model.repoPath,
    commonDir: model.commonDir,
    options: gitOptionsFor(options),
    previous: model.git,
    previousRows: model.source.kind === 'git' && model.git.signature ? model.rows : null,
    mustRun: full || listingOwed
  })
  return commit(result.rows, () => {
    model.git = result.state
  })
}
