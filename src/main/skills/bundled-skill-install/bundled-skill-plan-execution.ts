import { sameBundledSkillObserved } from './bundled-skill-plan-identity'
import type {
  BundledSkillCleanup,
  BundledSkillInstallResult,
  BundledSkillObserved,
  BundledSkillOp,
  BundledSkillOpOutcome,
  BundledSkillOutcome,
  BundledSkillPlanEntry
} from '../../../shared/bundled-skill-plan'
import {
  holdsCurrentBundledSkillCopy,
  isBundledSkillAutoUpdateOp
} from '../../../shared/bundled-skill-summary'
import type { BundledSkillSource } from './bundled-skill-sources'
import { classifyBundledSkillPath } from './bundled-skill-classification'
import { filesystemErrorCode } from './bundled-skill-filesystem-error'
import { buildBundledSkillPlan, type BundledSkillPlanInput } from './bundled-skill-plan'
import {
  BundledSkillChangedError,
  backUpBundledSkillPath,
  bundledSkillBackupPath,
  putBundledSkillFolder,
  removeBundledSkillSibling,
  replaceBundledSkillPath,
  retireBundledSkillPlacement,
  swapBundledSkillFolder
} from './bundled-skill-folder-swap'
import { findBundledSkillSource } from './bundled-skill-source-selection'
import { withBundledSkillTargetLocks } from './bundled-skill-target-locks'
import { recordBundledSkillDigestWritten } from './bundled-skill-written-digests'

export type BundledSkillExecuteInput = BundledSkillPlanInput & {
  /** Per-lock wait; the shared 5s default applies when unset. */
  lockTimeoutMs?: number
}

type SkillRun = {
  input: BundledSkillExecuteInput
  entry: BundledSkillPlanEntry
  source: BundledSkillSource
}

function verifier(run: SkillRun, path: string, expected: BundledSkillObserved) {
  return async () =>
    sameBundledSkillObserved(
      (
        await classifyBundledSkillPath(
          run.input.filesystem,
          path,
          run.source,
          run.entry.digest,
          'treeDigest' in expected
        )
      ).observed,
      expected
    )
}

async function requireUnchanged(run: SkillRun, path: string, expected: BundledSkillObserved) {
  if (!(await verifier(run, path, expected)())) {
    throw new BundledSkillChangedError(path)
  }
}

function backupFor(run: SkillRun): string {
  return bundledSkillBackupPath(run.input.destination.homeDirectory, run.entry.name)
}

async function settleCleanup(run: SkillRun, cleanup: BundledSkillCleanup) {
  await requireUnchanged(run, cleanup.path, cleanup.observed)
  await (cleanup.action === 'delete'
    ? removeBundledSkillSibling(run.input.filesystem, cleanup.path)
    : backUpBundledSkillPath(run.input.filesystem, cleanup.path, backupFor(run)))
}

/** The moved-aside copy held edits that could not be backed up; they stay at `path`. */
class BundledSkillStrandedError extends Error {
  constructor(
    readonly path: string,
    readonly code: string
  ) {
    super(`bundled-skill-stranded: ${path}`)
  }
}

/** Preserve bytes from a writer that raced the lock by re-hashing the moved-aside copy. */
async function settleOldCopy(run: SkillRun, old: string) {
  try {
    const { folderClass } = await classifyBundledSkillPath(
      run.input.filesystem,
      old,
      run.source,
      run.entry.digest
    )
    if (folderClass === 'current' || folderClass === 'released') {
      // A released leftover is the next plan's delete cleanup if this fails.
      await removeBundledSkillSibling(run.input.filesystem, old).catch(() => undefined)
      return undefined
    }
    return await backUpBundledSkillPath(run.input.filesystem, old, backupFor(run))
  } catch (error) {
    throw new BundledSkillStrandedError(old, filesystemErrorCode(error))
  }
}

function requireLinkTarget(op: BundledSkillOp): string {
  if (!op.linkTarget) {
    throw new Error('bundled-skill-link-without-target')
  }
  return op.linkTarget
}

async function applyContent(run: SkillRun, op: BundledSkillOp): Promise<string | undefined> {
  const { filesystem } = run.input
  const files = [{ path: 'SKILL.md', text: run.source.text }]
  const verify = verifier(run, op.path, op.observed)
  for (const cleanup of op.cleanup) {
    await settleCleanup(run, cleanup)
  }
  switch (op.kind) {
    case 'keep':
      return undefined
    case 'leave':
      // Agent links may depend on another build's shared copy; skip them if it changed since planning.
      if (op.reason === 'other-build') {
        await requireUnchanged(run, op.path, op.observed)
      }
      return undefined
    case 'write':
    case 'copy':
      await putBundledSkillFolder(filesystem, op.path, files, verify)
      return undefined
    case 'link':
      await requireUnchanged(run, op.path, op.observed)
      await filesystem.createLink(requireLinkTarget(op), op.path)
      return undefined
    case 'update': {
      const old = await swapBundledSkillFolder(filesystem, op.path, files, verify)
      // The new copy is in; unpreservable edits in the old copy surface as a stranded failure.
      return settleOldCopy(run, old)
    }
    case 'replace': {
      const backupPath = backupFor(run)
      await replaceBundledSkillPath(
        filesystem,
        op.path,
        backupPath,
        op.content === 'link' ? { linkTarget: requireLinkTarget(op) } : { files },
        verify
      )
      return backupPath
    }
    case 'restore': {
      const from = op.restoreFrom
      if (!from) {
        throw new Error('bundled-skill-restore-without-source')
      }
      await requireUnchanged(run, from.path, from.observed)
      await requireUnchanged(run, op.path, op.observed)
      await filesystem.rename(from.path, op.path)
      return undefined
    }
  }
}

async function applyOp(run: SkillRun, op: BundledSkillOp): Promise<string | undefined> {
  let backup = await applyContent(run, op)
  for (const previous of op.previous ?? []) {
    if (previous.retain) {
      await requireUnchanged(run, previous.path, previous.observed)
      continue
    }
    const retiredBackup = await retireBundledSkillPlacement(
      run.input.filesystem,
      previous.path,
      previous.forward ? op.path : undefined,
      (path) => verifier(run, path, previous.observed)(),
      backupFor(run)
    )
    backup ??= retiredBackup
  }
  return backup
}

/** Applies one skill's ops in order, then records its marker if this build's bytes are on disk. */
async function runSkill(run: SkillRun): Promise<BundledSkillOutcome> {
  const statuses = new Map<string, BundledSkillOpOutcome['status']>()
  const ops: BundledSkillOpOutcome[] = []
  for (const op of run.entry.ops) {
    const outcome: BundledSkillOpOutcome =
      op.requires && statuses.get(op.requires) !== 'done'
        ? { path: op.path, kind: op.kind, status: 'skipped' }
        : await applyOp(run, op).then(
            (backupPath) => ({
              path: op.path,
              kind: op.kind,
              status: 'done' as const,
              ...(op.reason ? { reason: op.reason } : {}),
              ...(backupPath ? { backupPath } : {})
            }),
            (error: unknown): BundledSkillOpOutcome =>
              error instanceof BundledSkillStrandedError
                ? {
                    path: op.path,
                    kind: op.kind,
                    status: 'failed',
                    error: error.code,
                    strandedPath: error.path
                  }
                : error instanceof BundledSkillChangedError
                  ? { path: op.path, kind: op.kind, status: 'changed' as const }
                  : {
                      path: op.path,
                      kind: op.kind,
                      status: 'failed' as const,
                      error: filesystemErrorCode(error)
                    }
          )
    // A stranded old copy still means the new copy is in place for dependent links.
    statuses.set(op.path, outcome.strandedPath ? 'done' : outcome.status)
    ops.push(outcome)
  }
  if (
    holdsCurrentBundledSkillCopy(run.entry) ||
    run.entry.ops.some((op) => op.content === 'files' && statuses.get(op.path) === 'done')
  ) {
    await recordOrcaCopy(run.input, run.entry)
  }
  return { name: run.entry.name, status: 'ran', ops }
}

/**
 * Lets other Orca builds on this host recognise these bytes as Orca's, not a user edit.
 * Execution only: preview stays read-only.
 */
function recordOrcaCopy(input: BundledSkillExecuteInput, entry: BundledSkillPlanEntry) {
  return recordBundledSkillDigestWritten(
    input.filesystem,
    input.destination.homeDirectory,
    entry.name,
    entry.digest
  )
}

/** Re-plan under all target locks and require the previewed digest; stale previews must write nothing. */
export async function executeBundledSkillPlan(
  input: BundledSkillExecuteInput,
  planDigest: string
): Promise<BundledSkillInstallResult> {
  const names = input.names ?? input.sources.map((source) => source.name)
  const unrun = (status: 'changed' | 'busy'): BundledSkillInstallResult => ({
    scope: input.destination.scope,
    skills: names.map((name) => ({ name, status, ops: [] }))
  })
  return withBundledSkillTargetLocks(input, unrun, async () => {
    const { plan } = await buildBundledSkillPlan(input)
    if (plan.planDigest !== planDigest) {
      return unrun('changed')
    }
    const skills: BundledSkillOutcome[] = []
    for (const entry of plan.skills) {
      skills.push(
        await runSkill({ input, entry, source: findBundledSkillSource(input.sources, entry.name) })
      )
    }
    return { scope: plan.scope, skills }
  })
}

/**
 * Plans each named installed skill under its locks and applies only hash-verified released-copy
 * updates; edited, foreign or interrupted locations are never touched. Each write re-checks its
 * location, and one skill's failure leaves the others' outcomes intact. `recordOnly` skips every
 * update and only records copies that already hold this build's bytes.
 */
export async function autoUpdateBundledSkills(
  input: BundledSkillExecuteInput & { names: readonly string[]; recordOnly?: boolean }
): Promise<BundledSkillInstallResult> {
  const unrun = (status: 'changed' | 'busy'): BundledSkillInstallResult => ({
    scope: input.destination.scope,
    skills: input.names.map((name) => ({ name, status, ops: [] }))
  })
  return withBundledSkillTargetLocks(input, unrun, async () => {
    const { plan } = await buildBundledSkillPlan({ ...input, installedOnly: true })
    const skills: BundledSkillOutcome[] = []
    for (const entry of plan.skills) {
      const safe = entry.ops.filter(isBundledSkillAutoUpdateOp)
      const required = new Set(safe.flatMap((op) => (op.requires ? [op.requires] : [])))
      const ops = entry.ops.filter(
        (op) => safe.includes(op) || (op.kind === 'keep' && required.has(op.path))
      )
      if (ops.length > 0 && !input.recordOnly) {
        const source = findBundledSkillSource(input.sources, entry.name)
        skills.push(await runSkill({ input, entry: { ...entry, ops }, source }))
      }
      // An already-current copy (keep-only, so nothing ran) written before markers existed.
      if (holdsCurrentBundledSkillCopy(entry)) {
        await recordOrcaCopy(input, entry)
      }
    }
    return { scope: plan.scope, skills }
  })
}
