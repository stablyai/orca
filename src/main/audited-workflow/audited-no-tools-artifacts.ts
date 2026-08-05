// Prepares the audited artifact bundle the no-tools adapter consumes.
//
// THE OWNERSHIP SPLIT THIS FILE EXISTS TO CREATE: retrieval lives here, in the
// orchestration's half, and the adapter only bounds and redacts what it is
// handed. That is what keeps the adapter host-agnostic — local, WSL, SSH, and
// folder workspaces all differ in HOW bytes are read, and none of that
// difference reaches audited-no-tools-adapter.ts.
//
// Every read goes through runAuditedGitRead, so the same allowlist and arity
// screens that guard every other audited Git call guard these too. Nothing here
// resolves a path from model output — mediated retrieval is a separate,
// scope-validated path in audited-no-tools-scope.ts.
import { app } from 'electron'
import { homedir } from 'node:os'
import { runAuditedGitRead } from './audited-worktree-commands'
import { NO_TOOLS_LIMITS } from '../../shared/audited-audit-mode-types'
import type { AuditedAcceptanceCriterion } from '../../shared/audited-workflow-types'
import type { BundleFile, BundleInput } from './audited-no-tools-bundle'

export type ArtifactPreparationArgs = {
  worktreePath: string
  /** The base tree the work is measured against. Full 40-hex. */
  baseTreeOid: string
  /** The candidate tree. Full 40-hex. */
  candidateTreeOid: string
}

export type PreparedArtifacts = {
  diffStat: string
  diff: string
  files: readonly BundleFile[]
}

/**
 * Reads the change summary and the unified diff.
 *
 * A FAILED READ IS NOT FATAL and yields an explicit placeholder rather than an
 * error. The model can still audit against the plan, criteria, and whatever
 * else the bundle carries, and the placeholder keeps the gap VISIBLE — both to
 * the model and in the stored evidence — instead of presenting a partial bundle
 * as a complete one. Silently sending an empty diff would let a verdict claim to
 * have reviewed changes it never saw.
 */
export async function prepareAuditArtifacts(
  args: ArtifactPreparationArgs
): Promise<PreparedArtifacts> {
  const [stat, patch] = await Promise.all([readDiff(args, '--stat'), readDiff(args, '--patch')])

  return {
    diffStat: stat,
    diff: patch,
    // FILES ARE DELIBERATELY EMPTY in the initial bundle. The diff already
    // carries the changed content, and inlining whole files on top of it would
    // double the payload for material the model mostly already has. A model that
    // genuinely needs surrounding context asks for it through mediated
    // retrieval, which is bounded and scope-validated — a far better trade than
    // speculatively shipping N files on every audit.
    files: []
  }
}

/**
 * Assembles the full BundleInput for a CODE audit.
 *
 * The redaction context carries every identity value main knows, so the bundle
 * cannot ship a worktree path, a source-repo path, a common dir, the userData
 * dir, the home dir, or the branch name — the same trusted-context set
 * sanitizeReviewSummary already uses on the way back.
 */
export async function buildNoToolsCodeAuditBundle(args: {
  task: {
    title: string
    baseCommit: string
    worktreePath: string | null
    sourceRepoPath: string | null
    sourceRepoCommonDir: string | null
    branchName: string | null
  }
  description: string
  criteria: readonly AuditedAcceptanceCriterion[]
  worktreePath: string
  candidateTreeOid: string
}): Promise<BundleInput> {
  // The BASE TREE, not the base commit: diff-tree's operands are compared as
  // trees, and passing a commit oid would diff the commit object itself.
  const baseTreeOid = await resolveTreeOid(args.worktreePath, args.task.baseCommit)

  const artifacts =
    baseTreeOid === null
      ? {
          diffStat: '(diff unavailable — Orca could not resolve the base tree)',
          diff: '',
          files: []
        }
      : await prepareAuditArtifacts({
          worktreePath: args.worktreePath,
          baseTreeOid,
          candidateTreeOid: args.candidateTreeOid
        })

  return {
    title: args.task.title,
    description: args.description,
    acceptanceCriteria: args.criteria,
    // Null: this is the CODE lane. The plan lane passes its sanitized plan text.
    planText: null,
    diffStat: artifacts.diffStat,
    diff: artifacts.diff,
    files: artifacts.files,
    redactionContext: {
      worktreePath: args.task.worktreePath,
      sourceRepoPath: args.task.sourceRepoPath,
      sourceRepoCommonDir: args.task.sourceRepoCommonDir,
      branchName: args.task.branchName,
      userDataPath: app.getPath('userData'),
      homePath: homedir()
    }
  }
}

/** Resolves `<commit>^{tree}` to a full OID, or null when it cannot be read. */
async function resolveTreeOid(worktreePath: string, commit: string): Promise<string | null> {
  const result = await runAuditedGitRead(
    ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`],
    worktreePath
  )
  if (!result.ok) {
    return null
  }
  const oid = result.stdout.trim()
  return /^[0-9a-f]{40}$/.test(oid) ? oid : null
}

async function readDiff(
  args: ArtifactPreparationArgs,
  form: '--stat' | '--patch'
): Promise<string> {
  const result = await runAuditedGitRead(
    ['diff-tree', '-r', form, args.baseTreeOid, args.candidateTreeOid, '--'],
    args.worktreePath
  )
  if (!result.ok) {
    // The stderr is NOT logged or carried: it can embed absolute paths, and the
    // caller has no use for it beyond knowing the read failed.
    console.error(`[auditedWorkflow] Reading the audit ${form} failed.`)
    return `(diff unavailable — Orca could not read it)`
  }
  const text = result.stdout
  const cap = form === '--stat' ? NO_TOOLS_LIMITS.maxFileBytes : NO_TOOLS_LIMITS.maxDiffBytes
  // A first cap at the READ boundary, before the bundle's own cap. Without it a
  // pathological diff is held whole in memory only to be truncated later.
  return text.length <= cap ? text : `${text.slice(0, cap)}\n[truncated by Orca]`
}
