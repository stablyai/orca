// Applies one planned op under the skill's locks, reporting what landed even when a later step fails.
import { basename, dirname } from 'node:path'
import { sameBundledSkillObserved } from './bundled-skill-plan-identity'
import type {
  BundledSkillCleanup,
  BundledSkillObserved,
  BundledSkillOp,
  BundledSkillOpOutcome,
  BundledSkillPlanEntry
} from '../../../shared/skills/bundled/bundled-skill-plan'
import type { BundledSkillSource } from './bundled-skill-sources'
import { bundledSkillOpKindPublishes } from '../../../shared/skills/bundled/bundled-skill-backup-refusal'
import { classifyBundledSkillPath } from './bundled-skill-classification'
import { filesystemErrorCode } from './bundled-skill-filesystem-error'
import type { BundledSkillPlanInput } from './bundled-skill-plan'
import { formerSkillRootPaths } from './former-skill-roots'
import {
  BundledSkillBackupRefusedError,
  BundledSkillChangedError,
  BundledSkillReplaceRestoreError,
  backUpBundledSkillPath,
  bundledSkillBackupPath,
  putBundledSkillFolder,
  removeBundledSkillSibling,
  replaceBundledSkillPath,
  retireBundledSkillPlacement,
  swapBundledSkillFolder
} from './bundled-skill-folder-swap'

export type SkillRun = {
  input: BundledSkillPlanInput
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

/** Every backup an op completed, kept even when a later step fails or refuses. */
type OpProgress = { backups: string[] }

async function settleCleanup(run: SkillRun, cleanup: BundledSkillCleanup, progress: OpProgress) {
  await requireUnchanged(run, cleanup.path, cleanup.observed)
  if (cleanup.action === 'delete') {
    await removeBundledSkillSibling(run.input.filesystem, cleanup.path)
    return
  }
  progress.backups.push(
    await backUpBundledSkillPath(run.input.filesystem, cleanup.path, backupFor(run), 'leftover')
  )
}

/** The moved-aside copy held edits that could not be backed up; they stay at `path`. */
class BundledSkillStrandedError extends Error {
  constructor(
    readonly path: string,
    cause: unknown
  ) {
    super(`bundled-skill-stranded: ${path}`, { cause })
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
    return await backUpBundledSkillPath(run.input.filesystem, old, backupFor(run), 'moved-aside')
  } catch (error) {
    throw new BundledSkillStrandedError(old, error)
  }
}

function requireLinkTarget(op: BundledSkillOp): string {
  if (!op.linkTarget) {
    throw new Error('bundled-skill-link-without-target')
  }
  return op.linkTarget
}

function isOwnNameKeep(run: SkillRun, op: BundledSkillOp): boolean {
  return op.kind === 'keep' && basename(op.path) === run.source.name
}

async function applyContent(
  run: SkillRun,
  op: BundledSkillOp,
  progress: OpProgress
): Promise<string | undefined> {
  const { filesystem } = run.input
  const files = [{ path: 'SKILL.md', text: run.source.text }]
  const verify = verifier(run, op.path, op.observed)
  for (const cleanup of op.cleanup) {
    if (cleanup.action === 'backup') {
      await settleCleanup(run, cleanup, progress)
    }
  }
  for (const cleanup of op.cleanup) {
    if (cleanup.action === 'delete') {
      await settleCleanup(run, cleanup, progress)
    }
  }
  switch (op.kind) {
    case 'keep':
      // Former placements and agent links rely on the skill's own copy; report it if it changed.
      // A former name's recovery keep is relied on by nothing, and its retirement may run first.
      if (isOwnNameKeep(run, op)) {
        await requireUnchanged(run, op.path, op.observed)
      }
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

export type AppliedOp = {
  outcome: BundledSkillOpOutcome
  /** This op's location was checked to hold the planned bytes, so it can back links and a marker. */
  verified: boolean
  /** The op's own step finished (or its copy was rechecked), so ops that require it may run. */
  satisfiesDependents: boolean
}

export async function applyOp(run: SkillRun, op: BundledSkillOp): Promise<AppliedOp> {
  const { path, kind, reason } = op
  const progress: OpProgress = { backups: [] }
  let primaryDone = false
  try {
    const primaryBackup = await applyContent(run, op, progress)
    if (primaryBackup) {
      progress.backups.push(primaryBackup)
    }
    primaryDone = true
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
      ).catch((error: unknown) => {
        // A copy put back in place sits where the user left it. If the put-back failed, nothing
        // rediscovers a former root's moved-aside copy, so say so once.
        if (
          error instanceof BundledSkillBackupRefusedError &&
          error.refusal.source === 'moved-aside' &&
          formerSkillRootPaths(run.input.destination).includes(dirname(previous.path))
        ) {
          throw new BundledSkillBackupRefusedError({
            ...error.refusal,
            onlyNotice: true
          })
        }
        throw error
      })
      if (retiredBackup) {
        progress.backups.push(retiredBackup)
      }
    }
    return {
      outcome: {
        path,
        kind,
        status: 'done',
        ...(reason && { reason }),
        ...backupFields(progress.backups)
      },
      verified: kind !== 'keep' || isOwnNameKeep(run, op),
      satisfiesDependents: true
    }
  } catch (error) {
    const strandedPath = error instanceof BundledSkillStrandedError ? error.path : undefined
    const failure =
      error instanceof BundledSkillStrandedError || error instanceof BundledSkillReplaceRestoreError
        ? error.cause
        : error
    if (error instanceof BundledSkillReplaceRestoreError) {
      progress.backups.push(error.backupPath)
    }
    // A stranded old copy was moved aside only after the new copy was published.
    primaryDone ||= Boolean(strandedPath)
    // Publication and a recheck are distinct: only the first may be reported as an update.
    const contentApplied = primaryDone && bundledSkillOpKindPublishes(kind)
    // A cleanup or retirement failing beside a kept copy leaves that copy in place. It can change
    // while the later step runs, so recheck it now rather than trust the check made before.
    const ownKeep = isOwnNameKeep(run, op)
    const currentConfirmed =
      ownKeep && (await verifier(run, op.path, op.observed)().catch(() => false))
    const partial = {
      path,
      kind,
      ...(contentApplied && { contentApplied: true as const }),
      ...(currentConfirmed && { currentConfirmed: true as const }),
      ...(strandedPath && { strandedPath }),
      ...backupFields(progress.backups)
    }
    const verified = (primaryDone && kind !== 'keep') || currentConfirmed
    // Links to a kept copy may follow only if it still is as planned.
    const satisfiesDependents = ownKeep ? currentConfirmed : primaryDone
    if (failure instanceof BundledSkillChangedError) {
      return {
        outcome: { ...partial, status: 'changed' },
        verified,
        satisfiesDependents
      }
    }
    if (failure instanceof BundledSkillBackupRefusedError) {
      return {
        outcome: {
          ...partial,
          status: 'failed',
          error: 'EXDEV',
          backupRefusal: failure.refusal
        },
        verified,
        satisfiesDependents
      }
    }
    return {
      outcome: {
        ...partial,
        status: 'failed',
        error: filesystemErrorCode(failure)
      },
      verified,
      satisfiesDependents
    }
  }
}

/** `backupPath` stays the first for older readers; `backupPaths` lists every completed backup. */
function backupFields(backups: readonly string[]) {
  return backups.length > 0 ? { backupPath: backups[0], backupPaths: [...backups] } : {}
}
