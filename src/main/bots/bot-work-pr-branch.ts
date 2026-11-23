// Whether a pull request is a bot's own work, as saved or by its head branch: a from=me rule starts on a pull
// request its owner opened, never on one a bot's worker opened as them (own-pr-trigger-guard.ts).
import { normalizeLocalBranchName } from '../runtime/workspaces/catalog/runtime-worktree-selection'
import type { BotWorkRecord, BotWorkWorker } from './bot-work-record'
import type { BotWorkRow, BotWorkSavedPr } from './bot-work-store'

/** A GitHub pull request's repository, as its webhook names it. */
export type BotPrRepo = {
  repoId: number
  /** owner/name, matched only when the workspace's repository id can't be read. */
  repoFullName: string
}

/** A repository by its id, which survives a rename or transfer, and its name, for when the id
 *  can't be read. */
export type BotGitHubRepo = { id: number | null; fullName: string }

/** A workspace's checked-out branch, and the GitHub repository it tracks, read only when asked. */
export type BotBranchWorkspace = {
  /** Null on a detached HEAD. */
  branch: string | null
  /** Null when it can't be told. */
  githubRepo: () => Promise<BotGitHubRepo | null>
}

/** A pull request by its base repository and number, and its head branch and repository. */
export type BotWorkPrHead = BotPrRepo & { number: number; head: BotPrRepo; headRef: string }

export type BotWorkRows = {
  /** Live rows of this profile's bots. */
  rows: () => readonly BotWorkRow[]
  /** Whether a pull request is saved as the work of one of this profile's bots. */
  saved: (pr: BotWorkPrHead) => boolean
  /** Saves a pull request as a row's work. */
  save: (row: BotWorkRow, pr: BotWorkPrHead) => void
  /** A row's worker's workspace now; null once it is closed or when it can't be read. */
  workspace: (row: BotWorkRow) => Promise<BotBranchWorkspace | null>
}

/** By id; by name when the id can't be read and the pull request names the repository (a fork's
 *  isn't sent). 'unknown' when neither can be told. */
async function repoMatches(
  workspace: BotBranchWorkspace,
  repo: BotPrRepo
): Promise<boolean | 'unknown'> {
  const own = await workspace.githubRepo().catch(() => null)
  if (!own) {
    return 'unknown'
  }
  if (own.id !== null) {
    return own.id === repo.repoId
  }
  return repo.repoFullName
    ? own.fullName.toLowerCase() === repo.repoFullName.toLowerCase()
    : 'unknown'
}

/**
 * The workspace has this branch checked out in this repository, at any commit. On that branch in a
 * repository that can't be told, it counts as on it: unknown never lets the bot's own pull request
 * start a run.
 */
export async function workspaceOnBranch(
  workspace: BotBranchWorkspace,
  repo: BotPrRepo,
  headRef: string
): Promise<boolean> {
  if (
    !workspace.branch ||
    normalizeLocalBranchName(workspace.branch) !== normalizeLocalBranchName(headRef)
  ) {
    return false
  }
  return (await repoMatches(workspace, repo)) !== false
}

/**
 * A pull request saved as a bot's work, else a live worker whose workspace has its head branch in the
 * head's repository, at any commit; that match saves it, so a later rename of the branch still finds
 * it. A workspace that can't be read now (an offline host) counts as not on it; one on the branch
 * whose repository can't be told counts as on it.
 */
export async function botWorkHasPrBranch(work: BotWorkRows, pr: BotWorkPrHead): Promise<boolean> {
  if (work.saved(pr)) {
    return true
  }
  for (const row of work.rows()) {
    const workspace = await work.workspace(row).catch(() => null)
    if (workspace && (await workspaceOnBranch(workspace, pr.head, pr.headRef))) {
      work.save(row, pr)
      return true
    }
  }
  return false
}

const savedPrOf = (pr: BotWorkPrHead): BotWorkSavedPr => ({
  repo: pr.repoFullName,
  repoId: Number.isFinite(pr.repoId) ? pr.repoId : null,
  number: pr.number
})

export function botWorkRowsForRuntime(
  botWork: Pick<BotWorkRecord, 'store' | 'check'>,
  hasBotId: (botId: string) => boolean,
  githubRepo: (worker: BotWorkWorker, branch: string) => Promise<BotGitHubRepo | null>
): BotWorkRows {
  return {
    rows: () =>
      botWork
        .store()
        .liveRows()
        .filter((row) => hasBotId(row.botId)),
    saved: (pr) => botWork.store().pullRequestBots(savedPrOf(pr)).some(hasBotId),
    save: (row, pr) => botWork.store().savePullRequest(row, savedPrOf(pr)),
    workspace: async (row) => {
      const checked = await botWork.check(row)
      const worker = checked?.worker
      const branch = checked?.workspace?.branch
      return worker && branch ? { branch, githubRepo: () => githubRepo(worker, branch) } : null
    }
  }
}
